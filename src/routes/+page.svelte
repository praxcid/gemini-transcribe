<script lang="ts">
	import { onMount } from 'svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let selectedFile: File | null = null;
	let uploadComplete = false;
	let isUploading = false;
	let fileUrl: string | null = null;
	let fileType: 'audio' | 'video';

	let streamBuffer = '';
	let transcriptArray: Array<{ timestamp: string; speaker: string; text: string }> = [];
	let language = 'Nepali Romanized English';
	let separateSpeakers = true;
	let model = 'gemini-3-flash-preview';
	let initialized = false;
	let errorMessage: string | null = null;

	let audioElement: HTMLAudioElement | null = null;
	let videoElement: HTMLVideoElement | null = null;
	let copiedToClipboard = false;

	onMount(() => {
		language = localStorage.getItem('transcriptionLanguage') || 'Nepali Romanized English';
		const sep = localStorage.getItem('separateSpeakers');
		separateSpeakers = sep === null ? true : sep === 'true';
		model = localStorage.getItem('transcriptionModel') || model;
		initialized = true;
	});

	$: if (initialized) {
		localStorage.setItem('transcriptionLanguage', language);
		localStorage.setItem('separateSpeakers', String(separateSpeakers));
		localStorage.setItem('transcriptionModel', model);
	}

	function handleTimestampClick(timestamp: string) {
		const parts = timestamp.split(':').map(Number);
		let timeInSeconds = 0;

		if (parts.length === 3) {
			timeInSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
		} else if (parts.length === 2) {
			timeInSeconds = parts[0] * 60 + parts[1]; // mm:ss
		}

		if (audioElement) {
			audioElement.currentTime = timeInSeconds;
			audioElement.play();
		}

		if (videoElement) {
			videoElement.currentTime = timeInSeconds;
			videoElement.play();
		}
	}

	function handleFileInput(event: Event) {
		errorMessage = null;
		const target = event.target as HTMLInputElement;
		selectedFile = target.files?.[0] ?? null;
		if (selectedFile) {
			fileUrl = URL.createObjectURL(selectedFile);
			fileType = selectedFile.type.includes('audio') ? 'audio' : 'video';
		}
	}

	function parseStreamedJson(
		buffer: string
	): Array<{ timestamp: string; speaker: string; text: string }> {
		const objectStrings = buffer.match(/{[^}]*}/g); // This regex attempts to find all substrings that look like complete JSON objects
		if (!objectStrings) {
			return [];
		}

		return objectStrings
			.map((objStr) => {
				try {
					const parsed = JSON.parse(objStr);
					if (
						parsed &&
						typeof parsed.timestamp === 'string' &&
						typeof parsed.speaker === 'string' &&
						typeof parsed.text === 'string'
					) {
						return parsed;
					}
					return null;
				} catch (e) {
					// This object string is likely incomplete or malformed, so we skip it
					// The next chunk from the stream might complete it
					return null;
				}
			})
			.filter((entry): entry is { timestamp: string; speaker: string; text: string } => !!entry);
	}

	async function handleSubmit() {
		if (!selectedFile) return;
		errorMessage = null;

		// Only allow files that are less than 512MB in size
		if (selectedFile.size >= 536870912) {
			alert('This file is too large. Please select a file that is less than 512MB.');
			return;
		}

		isUploading = true;

		const formData = new FormData();
		formData.append('file', selectedFile);
		formData.append('language', language);
		formData.append('separateSpeakers', String(separateSpeakers));
		formData.append('model', model);

		const response = await fetch('/api/upload', {
			method: 'POST',
			body: formData,
			headers: {
				Connection: 'keep-alive'
			}
		});

		if (!response.ok) {
			errorMessage = await response.text();
			isUploading = false;
			return;
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Response body is missing');
		}

		const decoder = new TextDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					let parsedData;

					try {
						parsedData = JSON.parse(streamBuffer);
					} catch (error) {
						const response = await fetch('/api/fix-json', {
							method: 'POST',
							headers: { 'Content-Type': 'text/plain' },
							body: streamBuffer
						});
						parsedData = (await response.json()).formattedJSON;
					}

					transcriptArray = [...parsedData];
					streamBuffer = '';
					uploadComplete = true;
					isUploading = false;
					break;
				}

				streamBuffer += decoder.decode(value, { stream: true });
				transcriptArray = parseStreamedJson(streamBuffer);
			}
		} finally {
			reader.cancel();
		}
	}



	async function downloadDocx({ timestamps = true } = {}) {
		const baseName = selectedFile
			? selectedFile.name.replace(/\.[^/.]+$/, '')
			: 'transcript';

		const response = await fetch('/api/download', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcriptArray, timestamps, filename: baseName, format: 'docx' })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${baseName}.docx`;
		a.click();
	}

	async function downloadDocxNoTimestamps() {
		await downloadDocx({ timestamps: false });
	}

	function reset() {
		selectedFile = null;
		uploadComplete = false;
		isUploading = false;
		fileUrl = null;
		streamBuffer = '';
		transcriptArray = [];
		errorMessage = null;
		if (audioElement) {
			audioElement.currentTime = 0;
			audioElement.pause();
		}
		if (videoElement) {
			videoElement.currentTime = 0;
			videoElement.pause();
		}
	}



	async function copyToClipboard() {
		const text = transcriptArray
			.map((entry) => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
			.join('\n');
		await navigator.clipboard.writeText(text);
		copiedToClipboard = true;
		setTimeout(() => {
			copiedToClipboard = false;
		}, 2000);
	}
</script>

<svelte:head>
	<title>Gemini Transcribe</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-gradient-to-br from-indigo-50 via-white to-cyan-50">
	<main class="container relative z-10 mx-auto flex-grow px-4 py-8">
		<section class="mb-6 text-center">
			<h1
				class="mb-4 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent md:text-4xl"
			>
				Gemini Transcribe
			</h1>
			<p class="mx-auto max-w-2xl text-xl leading-relaxed text-slate-700">
				Transform your audio and video files into accurate transcripts with speaker diarization and
				logically grouped timestamps.
			</p>
		</section>

		<div class="mx-auto max-w-4xl">
			{#if uploadComplete}
				<!-- Media Player Section -->
				<div
					class="mb-8 rounded-xl border border-indigo-200 bg-white/80 p-8 shadow-xl shadow-indigo-500/10 backdrop-blur-sm"
				>
					<div class="mb-8">
						{#if fileType === 'audio'}
							<audio src={fileUrl} controls class="h-12 w-full" bind:this={audioElement} />
						{:else if fileType === 'video'}
							<video
								src={fileUrl}
								controls
								class="w-full rounded-lg shadow-xl shadow-indigo-500/20"
								bind:this={videoElement}
							>
								<track kind="captions" />
							</video>
						{/if}
					</div>

					<!-- Download Actions -->
				<div class="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6">
				<button
					on:click={downloadDocxNoTimestamps}
					class="group relative w-full transform overflow-hidden rounded-lg bg-gradient-to-r from-fuchsia-600 to-rose-500 px-6 py-4 font-semibold text-white shadow-lg shadow-fuchsia-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-fuchsia-500/40"
				>
					<div class="relative flex items-center justify-center space-x-2">
						<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14m7-7H5" />
						</svg>
						<span>Download Transcript</span>
					</div>
				</button>
			</div>

			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
					<button
						on:click={copyToClipboard}
							class="group relative transform overflow-hidden rounded-lg border-2 border-slate-300 bg-white/90 px-6 py-4 font-semibold text-slate-700 shadow-lg shadow-slate-500/10 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:bg-slate-50 hover:shadow-xl hover:shadow-slate-500/20"
						>
							<div class="relative flex items-center justify-center space-x-2">
								<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
									/>
								</svg>
								<span>Start Over</span>
							</div>
						</button>
					</div>
				</div>
			{:else}
				<!-- Upload Section -->
				<div
					class="mb-8 rounded-xl border border-indigo-200 bg-white/80 p-8 shadow-xl shadow-indigo-500/10 backdrop-blur-sm"
				>
					<div class="mb-8">
						<div class="flex gap-4">
							<div
								class="mb-2 inline-flex h-20 w-20 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-100 to-purple-100 shadow-lg shadow-indigo-500/20"
							>
								<svg
									class="h-10 w-10 text-indigo-600"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
									/>
								</svg>
							</div>
							<div>
								<h2 class="mb-2 text-2xl font-bold text-slate-800">Upload Your Media</h2>
								<p class="text-slate-600">Select an audio or video file to begin transcription</p>
							</div>
						</div>
					</div>

					<div class="space-y-6">
						<div>
							<Label for="audio-file" class="mb-2 block text-sm font-medium text-slate-700">
								Choose File
							</Label>
							<div class="relative">
								<Input
									type="file"
									on:input={handleFileInput}
									id="audio-file"
									accept="audio/*,video/*"
									class="block h-16 w-full rounded-lg border-2 border-indigo-200 bg-white/90 text-sm text-slate-700 shadow-sm backdrop-blur-sm file:mr-4 file:rounded-lg file:border-0 file:bg-gradient-to-r file:from-indigo-600 file:to-purple-600 file:px-6 file:py-3 file:text-sm file:font-semibold file:text-white file:transition-all file:duration-300 hover:file:shadow-lg hover:file:shadow-indigo-500/25 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
								/>
							</div>
						</div>

						<div>
							<Label for="language" class="mb-2 block text-sm font-medium text-slate-700">
								Language of Transcript
							</Label>
							<select
								id="language"
								bind:value={language}
								class="w-full rounded-lg border-2 border-indigo-200 bg-white/90 px-4 py-3 text-slate-800 shadow-sm backdrop-blur-sm transition-all duration-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
							>
								<option value="English">English</option>
								<option value="Australian English">Australian English</option>
								<option value="Nepali Romanized English">Nepali Romanized English</option>
							</select>

							<div class="mt-3">
								<label for="model" class="mb-2 block text-sm font-medium text-slate-700">Model</label>
								<select
									id="model"
									bind:value={model}
									class="w-full rounded-lg border-2 border-indigo-200 bg-white/90 px-4 py-3 text-slate-800 shadow-sm backdrop-blur-sm transition-all duration-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
								>
									<option value="gemini-3-flash-preview">gemini-3-flash-preview (default)</option>
									<option value="gemini-2.5-flash">gemini-2.5-flash</option>
									<option value="gemini-2.5-flash-lite-preview-09-2025">flash-lite (fallback)</option>
								</select>
							</div>

							<div class="mt-3 flex items-start space-x-2">
								<input
									type="checkbox"
									id="separate-speakers"
									class="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
									bind:checked={separateSpeakers}
								/>
								<label for="separate-speakers" class="text-sm text-slate-700">
									Separate speakers
								</label>
							</div>
						</div>

						{#if errorMessage}
							<div
								class="mb-4 flex items-center space-x-3 rounded-lg border-2 border-red-300 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm"
								role="alert"
							>
								<svg
									class="h-5 w-5 flex-shrink-0"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
									/>
								</svg>
								<span>{errorMessage}</span>
							</div>
						{/if}

						<button
							on:click={handleSubmit}
							class="group relative w-full transform overflow-hidden rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:transform-none"
							disabled={!selectedFile || isUploading}
						>
							<div class="relative flex items-center justify-center space-x-2">
								{#if isUploading}
									<svg
										class="h-5 w-5 animate-spin"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									<span>Processing...</span>
								{:else}
									<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
										/>
									</svg>
									<span>Upload & Transcribe</span>
								{/if}
							</div>
						</button>

						<div class="text-center">
							<div
								class="rounded-lg border-2 border-cyan-200 bg-gradient-to-r from-cyan-50 to-blue-50 p-4 text-sm text-cyan-800 shadow-sm"
							>
								<p>Supported formats: MP3, WAV, MP4, AVI & more</p>
								<p>Maximum file size: 512MB</p>
								<p>This app uses an experimental model. If processing fails, please try again</p>
							</div>
						</div>

						{#if isUploading}
							<div class="text-center">
								<div class="inline-flex items-center space-x-2 text-indigo-600">
									<svg
										class="h-5 w-5 animate-spin"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
										/>
									</svg>
									<span class="font-medium"
										>Processing your file... This may take a few minutes</span
									>
								</div>
							</div>
						{:else}
							<div class="text-center">
								<!-- Sample audio option removed -->
							</div>
						{/if}
					</div>
				</div>

				<!-- model dropdown moved above; duplicate removed -->
			{/if}

			<!-- Transcript Display -->
			{#if transcriptArray.length > 0}
				<div class="space-y-4">
					<div class="mb-8 text-center">
						<h3
							class="mb-2 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-2xl font-bold text-transparent"
						>
							Transcript
						</h3>
						<p class="text-slate-600">Click on timestamps to jump to that moment</p>
					</div>

					{#each transcriptArray as entry, index}
						<div
							class="group rounded-xl border border-slate-200 bg-white/90 p-6 shadow-lg shadow-slate-500/10 backdrop-blur-sm transition-all duration-300"
						>
							<div
								class="flex flex-col space-y-3 sm:flex-row sm:items-start sm:space-x-4 sm:space-y-0"
							>
								<button
									class="inline-flex flex-shrink-0 transform items-center justify-center rounded-full bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:scale-105 hover:shadow-xl hover:shadow-indigo-500/40"
									on:click={() => handleTimestampClick(entry.timestamp)}
								>
									{entry.timestamp}
								</button>
								<div class="min-w-0 flex-1">
								<div class="mb-3">
									<span class="text-sm font-bold text-slate-800">{entry.speaker}:</span>
									</div>
									<p class="font-medium leading-relaxed text-slate-800">{entry.text}</p>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</main>

	<footer class="relative z-10 mt-auto border-t border-indigo-200 bg-white/80 backdrop-blur-sm">
		<div class="container mx-auto px-4 py-4" />
	</footer>
</div>
