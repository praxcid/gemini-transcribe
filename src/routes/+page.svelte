<script lang="ts">
	import { onMount } from 'svelte';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let selectedFiles: File[] = [];
	let uploadComplete = false;
	let isUploading = false;
	let fileUrls: string[] = [];
	let fileTypes: ('audio' | 'video')[] = [];

	let streamBuffers: string[] = [];
	let transcripts: Array<Array<{ timestamp: string; speaker: string; text: string }>> = [];
	let language = 'English';
	let separateSpeakers = true; // user option to separate or not
	let showTimestamps = false; // default off; user can enable to show timestamps
	let medicalMode = true; // default on (Medical checkbox checked)
	let model = 'gemini-2.5-flash'; // default AI model
	let initialized = false;

	let audioElements: (HTMLAudioElement | null)[] = [];
	let videoElements: (HTMLVideoElement | null)[] = [];
	let fileDurations: number[] = [];
	let userChangedModel = false; // if user manually picks a model or had a stored preference

	onMount(() => {
		language = localStorage.getItem('transcriptionLanguage') || 'English';
		model = localStorage.getItem('aiModel') || 'gemini-2.5-flash';
		// Migrate deprecated model names
		if (model === 'gemini-2.0-pro-exp') {
			model = 'gemini-2.5-pro';
		}
		userChangedModel = !!localStorage.getItem('aiModel');
		const storedSeparate = localStorage.getItem('separateSpeakers');
		if (storedSeparate !== null) {
			separateSpeakers = storedSeparate === 'true';
		}
		const storedShowTimestamps = localStorage.getItem('showTimestamps');
		if (storedShowTimestamps !== null) {
			showTimestamps = storedShowTimestamps === 'true';
		}
		initialized = true;
	});

	$: if (initialized) {
		localStorage.setItem('transcriptionLanguage', language);
		localStorage.setItem('separateSpeakers', String(separateSpeakers));
		localStorage.setItem('showTimestamps', String(showTimestamps));
		localStorage.setItem('aiModel', model);
		// Intentionally not persisting medicalMode to keep it always defaulting to checked
	}

	function handleTimestampClick(timestamp: string, index: number) {
		const parts = timestamp.split(':').map(Number);
		let timeInSeconds = 0;

		if (parts.length === 3) {
			timeInSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2]; // hh:mm:ss
		} else if (parts.length === 2) {
			timeInSeconds = parts[0] * 60 + parts[1]; // mm:ss
		}

		const audioElement = audioElements[index];
		if (audioElement) {
			audioElement.currentTime = timeInSeconds;
			audioElement.play();
		}

		const videoElement = videoElements[index];
		if (videoElement) {
			videoElement.currentTime = timeInSeconds;
			videoElement.play();
		}
	}

	function handleFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		selectedFiles = Array.from(target.files ?? []);
		fileUrls = selectedFiles.map((file) => URL.createObjectURL(file));
		fileTypes = selectedFiles.map((file) => (file.type.includes('audio') ? 'audio' : 'video'));
		fileDurations = [];
	}

	function handleModelChange() {
		userChangedModel = true;
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
		if (selectedFiles.length === 0) return;

		isUploading = true;
		transcripts = Array(selectedFiles.length).fill([]);
		streamBuffers = Array(selectedFiles.length).fill('');

		await Promise.all(
			selectedFiles.map(async (file, index) => {
				const fileUrl = fileUrls[index];
				const fileType = fileTypes[index];

				// Only allow files that are less than 2 hours in length
				const tempMediaElement = document.createElement(fileType === 'audio' ? 'audio' : 'video');
				tempMediaElement.src = fileUrl;

				const duration = await new Promise<number>((resolve, reject) => {
					tempMediaElement.onloadedmetadata = () => resolve(tempMediaElement.duration as number);
					tempMediaElement.onerror = reject;
				});

				fileDurations[index] = duration;
				// Auto-select model if user hasn't chosen one explicitly
				if (!userChangedModel) {
					const haveAll = fileDurations.filter((d) => typeof d === 'number').length === selectedFiles.length;
					if (haveAll) {
						const total = fileDurations.reduce((a, b) => a + (b || 0), 0);
						let auto = model;
						if (selectedFiles.length <= 2 && total < 1800) {
							auto = 'gemini-2.5-pro'; // short tasks: quality
						} else {
							auto = 'gemini-2.5-flash'; // longer/many files: speed
						}
						if (model !== auto) {
							model = auto;
						}
					}
				}

				if (duration >= 7200) {
					alert(
						`File "${file.name}" is too long. Please select a file that is less than 2 hours in length.`
					);
					return;
				}

				const formData = new FormData();
				formData.append('file', file);
				formData.append('language', language);
				formData.append('separateSpeakers', String(separateSpeakers));
				formData.append('medicalMode', String(medicalMode));
				formData.append('model', model);

				const response = await fetch('/api/upload', {
					method: 'POST',
					body: formData,
					headers: {
						Connection: 'keep-alive'
					}
				});

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
								parsedData = JSON.parse(streamBuffers[index]);
							} catch (error) {
								const response = await fetch('/api/fix-json', {
									method: 'POST',
									headers: { 'Content-Type': 'text/plain' },
									body: streamBuffers[index]
								});
								parsedData = (await response.json()).formattedJSON;
							}

							transcripts[index] = [...parsedData];
							streamBuffers[index] = '';
							break;
						}

						streamBuffers[index] += decoder.decode(value, { stream: true });
						transcripts[index] = parseStreamedJson(streamBuffers[index]);
					}
				} finally {
					reader.cancel();
				}
			})
		);

		uploadComplete = true;
		isUploading = false;
	}

	async function downloadTranscript({ timestamps = true } = {}) {
		const response = await fetch('/api/download', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcripts.flat(), timestamps, separateSpeakers })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		// Use the first selected file's base name for the download (strip extension), fallback to 'transcript'
		let baseName = 'transcript';
		if (selectedFiles.length > 0) {
			const original = selectedFiles[0].name;
			const lastDot = original.lastIndexOf('.');
			baseName = lastDot > 0 ? original.slice(0, lastDot) : original;
		}
		a.download = `${baseName}.doc`;
		a.click();
	}

	async function downloadAllZip({ timestamps = false } = {}) {
		if (transcripts.length <= 1) return;
		const response = await fetch('/api/download-all', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				transcripts,
				timestamps,
				separateSpeakers,
				fileNames: selectedFiles.map((f) => f.name)
			})
		});
		if (!response.ok) return;
		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcripts.zip';
		a.click();
	}

	async function downloadTranscriptForIndex(index: number, { timestamps = false } = {}) {
		if (!transcripts[index] || transcripts[index].length === 0) return;
		const response = await fetch('/api/download', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				transcript: transcripts[index],
				timestamps,
				separateSpeakers
			})
		});
		if (!response.ok) return;
		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		const original = selectedFiles[index]?.name || `transcript_${index + 1}`;
		const lastDot = original.lastIndexOf('.');
		const baseName = lastDot > 0 ? original.slice(0, lastDot) : original;
		a.href = url;
		a.download = `${baseName}.doc`;
		a.click();
	}

	async function downloadSRT() {
		const response = await fetch('/api/srt', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcripts.flat() })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.srt';
		a.click();
	}

	function reset() {
		selectedFiles = [];
		uploadComplete = false;
		isUploading = false;
		fileUrls = [];
		streamBuffers = [];
		transcripts = [];
		audioElements.forEach((el) => {
			if (el) {
				el.currentTime = 0;
				el.pause();
			}
		});
		videoElements.forEach((el) => {
			if (el) {
				el.currentTime = 0;
				el.pause();
			}
		});
	}
</script>

<svelte:head>
	<title>Paragon Transcribe</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-gradient-to-br from-indigo-50 via-white to-cyan-50">
	<div
		class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMzNzM2ZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-30"
	></div>

	<main class="container relative z-10 mx-auto flex-grow px-4 py-8">
		<section class="mb-6 text-center">
			<h1
				class="mb-4 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent md:text-4xl"
			>
				Paragon Transcribe
			</h1>
			
		</section>

		<div class="mx-auto max-w-4xl">
			{#if uploadComplete}
				<!-- Media Player Section -->
				{#each selectedFiles as file, index}
				<div
					class="mb-8 rounded-xl border border-indigo-200 bg-white/80 p-8 shadow-xl shadow-indigo-500/10 backdrop-blur-sm"
				>
					<div class="mb-8">
						<h2 class="text-xl font-bold mb-4">{file.name}</h2>
						{#if selectedFiles.length > 1 && transcripts[index] && transcripts[index].length > 0}
							<button
								on:click={() => downloadTranscriptForIndex(index, { timestamps: false })}
								class="mb-4 inline-flex items-center space-x-2 rounded-lg bg-gradient-to-r from-teal-600 to-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-emerald-500/30 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
							>
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
								</svg>
								<span>Download This Transcript (.doc)</span>
							</button>
						{/if}
						{#if fileTypes[index] === 'audio'}
							<audio
								src={fileUrls[index]}
								controls
								class="h-12 w-full rounded-lg shadow-lg shadow-indigo-500/20"
								bind:this={audioElements[index]}
							/>
						{:else if fileTypes[index] === 'video'}
								<!-- a11y-ignore missing-track -->
								<video
									src={fileUrls[index]}
									controls
									muted
									class="w-full rounded-lg shadow-xl shadow-indigo-500/20"
									bind:this={videoElements[index]}
								/>
						{/if}
					</div>

					<!-- Transcript Display -->
					{#if transcripts[index] && transcripts[index].length > 0}
						<div class="space-y-4">
							<div class="mb-8 text-center">
								<h3
									class="mb-2 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-2xl font-bold text-transparent"
								>
									Transcript
								</h3>
								{#if showTimestamps}
									<p class="text-slate-600">Click on timestamps to jump to that moment</p>
								{/if}
							</div>

							{#each transcripts[index] as entry, i}
								<div
									class="group rounded-xl border border-slate-200 bg-white/90 p-6 shadow-lg shadow-slate-500/10 backdrop-blur-sm transition-all duration-300 hover:scale-[1.01] hover:shadow-xl hover:shadow-slate-500/20"
								>
									<div
										class="flex flex-col space-y-3 sm:flex-row sm:items-start sm:space-x-4 sm:space-y-0"
									>
										{#if showTimestamps}
											<button
												class="inline-flex flex-shrink-0 transform items-center justify-center rounded-full bg-gradient-to-r from-indigo-600 to-purple-600 px-4 py-2 text-sm font-bold text-white shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:scale-105 hover:shadow-xl hover:shadow-indigo-500/40"
												on:click={() => handleTimestampClick(entry.timestamp, index)}
											>
												{entry.timestamp}
											</button>
										{/if}
										<div class="min-w-0 flex-1">
											<div class="mb-3 flex items-center space-x-2">
												{#if separateSpeakers}
													<span
														class="inline-flex items-center rounded-full border-2 border-emerald-200 bg-gradient-to-r from-emerald-100 to-teal-100 px-3 py-1 text-sm font-semibold text-emerald-700 shadow-sm"
													>
														{entry.speaker}
													</span>
												{/if}
											</div>
											<p class="font-medium leading-relaxed text-slate-800">{entry.text}</p>
										</div>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
				{/each}

				<!-- Download & Reset Actions on same line -->
				<div class="mb-6 flex flex-col gap-4 md:flex-row">
					{#if selectedFiles.length === 1}
						<button
							on:click={() => downloadTranscript({ timestamps: false })}
							class="flex-1 group relative transform overflow-hidden rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-6 py-4 font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-emerald-500/40"
						>
							<div class="relative flex items-center justify-center space-x-2">
								<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
									/>
								</svg>
								<span>Download Transcript</span>
							</div>
						</button>
					{/if}
					{#if selectedFiles.length > 1}
						<button
							on:click={() => downloadAllZip({ timestamps: false })}
							class="flex-1 group relative transform overflow-hidden rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/40"
						>
							<div class="relative flex items-center justify-center space-x-2">
								<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M3 7l6 6-6 6M9 7h4a2 2 0 012 2v10m4-6h4m0 0l-2-2m2 2l-2 2"
									/>
								</svg>
								<span>Download All Transcripts (ZIP)</span>
							</div>
						</button>
					{/if}
					<button
						on:click={reset}
						class="flex-1 group relative transform overflow-hidden rounded-lg border-2 border-slate-300 bg-white/90 px-6 py-4 font-semibold text-slate-700 shadow-lg shadow-slate-500/10 backdrop-blur-sm transition-all duration-300 hover:-translate-y-1 hover:bg-slate-50 hover:shadow-xl hover:shadow-slate-500/20"
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
								<p class="text-slate-600">Select one or more audio or video files to begin transcription</p>
							</div>
						</div>
					</div>

					<div class="space-y-6">
						<div>
							<Label for="audio-file" class="mb-2 block text-sm font-medium text-slate-700">
								Choose Files
							</Label>
							<div class="relative">
								<Input
									type="file"
									on:input={handleFileInput}
									id="audio-file"
									accept="audio/*,video/*"
									multiple
									class="block h-16 w-full rounded-lg border-2 border-indigo-200 bg-white/90 text-sm text-slate-700 shadow-sm backdrop-blur-sm file:mr-4 file:rounded-lg file:border-0 file:bg-gradient-to-r file:from-indigo-600 file:to-purple-600 file:px-6 file:py-3 file:text-sm file:font-semibold file:text-white file:transition-all file:duration-300 hover:file:shadow-lg hover:file:shadow-indigo-500/25 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
								/>
							</div>
							{#if selectedFiles.length > 0}
								<div class="mt-4">
									<p class="font-medium text-slate-700">Selected files:</p>
									<ul class="list-disc list-inside text-slate-600">
										{#each selectedFiles as file}
											<li>{file.name}</li>
										{/each}
									</ul>
								</div>
							{/if}
						</div>

						<div>
							<Label for="language" class="mb-2 block text-sm font-medium text-slate-700">
								Language of Transcript
							</Label>
							<select
								bind:value={language}
								id="language"
								class="w-full rounded-lg border-2 border-indigo-200 bg-white/90 px-4 py-3 text-slate-800 placeholder-slate-400 shadow-sm backdrop-blur-sm transition-all duration-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
							>
								<option value="English">English</option>
								<option value="Australian English">Australian English</option>
								<option value="Nepali Romanized English">Nepali Romanized English</option>
								<option value="Nepali">Nepali</option>
							</select>
						</div>

						<div>
							<Label for="model" class="mb-2 block text-sm font-medium text-slate-700">
								AI Model
							</Label>
							<p class="mb-2 text-xs text-slate-500">Auto-selects faster model for long batches; switch manually if you prefer.</p>
							<select
								bind:value={model}
								id="model"
								on:change={handleModelChange}
								class="w-full rounded-lg border-2 border-indigo-200 bg-white/90 px-4 py-3 text-slate-800 placeholder-slate-400 shadow-sm backdrop-blur-sm transition-all duration-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
							>
								<option value="gemini-2.5-flash">Gemini 2.5 Flash (fast)</option>
								<option value="gemini-2.5-pro">Gemini 2.5 Pro (higher quality)</option>
								<option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
								<option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
							</select>
							<div class="mt-2 rounded-md border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700 flex items-center gap-2">
								<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
								<span>Using <strong>{model}</strong> {userChangedModel ? '(manual selection)' : '(auto-selected)'}</span>
							</div>
						</div>

						<div class="flex items-center space-x-2">
							<input
								id="separate-speakers"
								type="checkbox"
								bind:checked={separateSpeakers}
								class="h-5 w-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
							/>
							<label for="separate-speakers" class="text-sm font-medium text-slate-700"
								>Separate Speakers</label
							>
						</div>

						<div class="flex items-center space-x-2">
							<input
								id="show-timestamps"
								type="checkbox"
								bind:checked={showTimestamps}
								class="h-5 w-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
							/>
							<label for="show-timestamps" class="text-sm font-medium text-slate-700"
								>Show Timestamps</label
							>
						</div>

						<div class="flex items-center space-x-2">
							<input
								id="medical-mode"
								type="checkbox"
								bind:checked={medicalMode}
								class="h-5 w-5 rounded border-indigo-300 text-indigo-600 focus:ring-indigo-500"
							/>
							<label for="medical-mode" class="text-sm font-medium text-slate-700">Medical</label>
						</div>

						<button
							on:click={handleSubmit}
							class="group relative w-full transform overflow-hidden rounded-lg bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-4 font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:transform-none"
							disabled={selectedFiles.length === 0 || isUploading}
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
								<p>📁 Supported formats: MP3, WAV, MP4, AVI & more</p>
								<p>⏱️ Maximum duration: 2 hours per file</p>
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
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</main>

	<footer class="relative z-10 mt-auto border-t border-indigo-200 bg-white/80 backdrop-blur-sm">
		<div class="container mx-auto px-4 py-4">
			<div class="text-center text-slate-500">
				<p class="text-sm">
					by
					<a
						href="https://paragontranscriptions.com"
						class="font-medium text-indigo-600 transition-colors duration-200 hover:text-purple-600"
					>
						paragontranscriptions.com
					</a>
				</p>
			</div>
		</div>
	</footer>
</div>