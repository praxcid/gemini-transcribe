<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let selectedFile: File | null = null;
	let uploadComplete = false;
	let isUploading = false;
	let fileUrl: string | null = null;
	let fileType: 'audio' | 'video';

	let streamBuffer = '';
	let transcriptArray: Array<{ timestamp: string; speaker: string; text: string }> = [];

	let audioElement: HTMLAudioElement | null = null;
	let videoElement: HTMLVideoElement | null = null;

	$: if (streamBuffer) {
		window.scrollTo({
			top: document.body.scrollHeight + 50,
			behavior: 'smooth'
		});
	}

	$: if (transcriptArray.length) {
		window.scrollTo(0, 0);
	}

	function handleTimestampClick(timestamp: string) {
		const [minutes, seconds] = timestamp.split(':').map(Number);
		const timeInSeconds = minutes * 60 + seconds;

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
		const target = event.target as HTMLInputElement;
		selectedFile = target.files?.[0] ?? null;
		if (selectedFile) {
			fileUrl = URL.createObjectURL(selectedFile);
			fileType = selectedFile.type.includes('audio') ? 'audio' : 'video';
		}
	}

	async function handleSubmit() {
		if (!selectedFile) return;

		// Only allow files that are less than 1 hour in length
		const tempMediaElement = document.createElement(fileType === 'audio' ? 'audio' : 'video');
		tempMediaElement.src = fileUrl;

		const duration = await new Promise((resolve, reject) => {
			tempMediaElement.onloadedmetadata = () => resolve(tempMediaElement.duration);
			tempMediaElement.onerror = reject;
		});

		if (duration >= 3600) {
			alert('This file is too long. Please select a file that is less than 1 hour in length.');
			return;
		}

		isUploading = true;

		const formData = new FormData();
		formData.append('file', selectedFile);

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
			}
		} finally {
			reader.cancel();
		}
	}

	async function downloadTranscript({ timestamps = true } = {}) {
		const response = await fetch('/api/download', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcriptArray, timestamps })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.txt';
		a.click();
	}

	async function downloadSRT() {
		const response = await fetch('/api/srt', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ transcript: transcriptArray })
		});

		const blob = await response.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'transcript.srt';
		a.click();
	}

	async function useSample() {
		const sampleFile = await fetch('/gettysburg-address.mp3');
		const blob = await sampleFile.blob();
		selectedFile = new File([blob], 'sample.mp3', { type: 'audio/mp3' });
		fileUrl = URL.createObjectURL(selectedFile);
		fileType = 'audio';
		handleSubmit();
	}
</script>

<svelte:head>
	<title>Gemini Transcribe</title>
</svelte:head>

<div class="flex min-h-screen flex-col">
	<main class="container mx-auto flex-1 px-4 py-8">
		<section class="mb-12 text-center">
			<h1 class="mb-4 text-4xl font-bold text-blue-600">Gemini Transcribe</h1>
			<p class="text-xl text-gray-600">
				Transcribe audio and video files with speaker diarization and logically grouped timestamps.
			</p>
		</section>

		<div class="mx-auto max-w-2xl">
			{#if uploadComplete}
				<div class="mb-6">
					{#if fileType === 'audio'}
						<audio src={fileUrl} controls class="mx-auto w-full" bind:this={audioElement} />
					{:else if fileType === 'video'}
						<video src={fileUrl} controls class="mx-auto w-full" bind:this={videoElement} />
					{/if}
				</div>

				<button
					on:click={downloadTranscript}
					class="w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
				>
					Download Transcript
				</button>
				<button
					on:click={() => downloadTranscript({ timestamps: false })}
					class="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
				>
					Download Transcript (no timestamps)
				</button>
				<button
					on:click={downloadSRT}
					class="mt-2 w-full rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
				>
					Download Subtitles (SRT)
				</button>
			{:else}
				<div class="mb-8 rounded-lg bg-white p-6 shadow-md">
					<h2 class="mb-4 text-2xl font-semibold">Upload Your File</h2>
					<Label for="audio-file" class="mb-2 block text-sm font-medium text-gray-700"
						>Select an audio or video file</Label
					>
					<Input
						type="file"
						on:input={handleFileInput}
						id="audio-file"
						accept="audio/*,video/*"
						class="mb-4 w-full cursor-pointer rounded-lg border border-gray-300 bg-gray-50 p-2.5 text-sm text-gray-900 focus:border-blue-500 focus:ring-blue-500"
					/>
					<button
						on:click={handleSubmit}
						class="mb-4 w-full rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white shadow-md transition duration-300 ease-in-out hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 disabled:cursor-not-allowed disabled:bg-gray-400"
						disabled={!selectedFile || isUploading}
					>
						{isUploading ? 'Processing...' : 'Upload File'}
					</button>

					<p class="space-y-2 text-sm text-gray-700">
						Transcribe mp3, wav, mp4, avi & more. Duration limit of 1 hour per file. This app uses
						an experimental model. If processing fails, please try again.
					</p>

					{#if isUploading}
						<p class="mt-2 text-sm font-bold text-gray-600">
							Processing file - this may take a few minutes.
						</p>
					{:else}
						<button
							on:click={useSample}
							class="mt-4 text-sm text-gray-600 underline hover:text-gray-800 focus:outline-none"
						>
							Try transcribing a sample file
						</button>
					{/if}
				</div>
			{/if}

			<div class="mb-2">
				{streamBuffer}
			</div>

			<div class="transcript mt-8">
				{#each transcriptArray as entry, index}
					<div class="mb-4 rounded-lg {index % 2 === 0 ? 'bg-gray-50' : 'bg-white'} p-4 shadow-sm">
						<button
							class="mb-2 block rounded-full bg-indigo-500 px-3 py-1 text-sm font-bold text-white shadow-md transition duration-300 ease-in-out hover:bg-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50"
							on:click={() => handleTimestampClick(entry.timestamp)}
						>
							{entry.timestamp}
						</button>
						<span class="font-bold text-gray-700">{entry.speaker}:</span>
						<span class="text-gray-800">{entry.text}</span>
					</div>
				{/each}
			</div>
		</div>
	</main>

	<footer>
		<div class="container mx-auto px-4 py-8 text-center text-gray-600">
			<p class="text-sm">
				by <a
					href="https://mikeesto.com"
					class="text-blue-400 hover:text-blue-600 focus:outline-none">@mikeesto</a
				>
			</p>
			<p class="mt-1 text-sm">suggestions/feedback? i'd love to hear from you</p>
		</div>
	</footer>
</div>
