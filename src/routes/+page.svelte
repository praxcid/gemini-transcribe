<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let selectedFile: File | null = null;
	let uploadComplete = false;
	let isUploading = false;
	let fileUrl: string | null = null;
	let fileType: 'audio' | 'video';

	let buffer = '';
	let transcriptArray: Array<{ timestamp: string; speaker: string; text: string }> = [];

	let audioElement: HTMLAudioElement | null = null;
	let videoElement: HTMLVideoElement | null = null;

	$: if (buffer) {
		window.scrollTo({
			top: document.body.scrollHeight + 50,
			behavior: 'smooth'
		});
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

		// TODO: For debugging purposes
		if (buffer) {
			try {
				const jsonChunk = JSON.parse(buffer);
				transcriptArray = [...jsonChunk];
				buffer = '';
				uploadComplete = true;
				return;
			} catch (error) {
				console.error('Error parsing JSON:', error);
			}
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
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				try {
					const jsonChunk = JSON.parse(buffer);
					transcriptArray = [...jsonChunk];
					buffer = '';
					uploadComplete = true;
					isUploading = false;
				} catch (error) {
					console.error('Error parsing JSON:', error);
				}

				break;
			}

			buffer += decoder.decode(value, { stream: true });
		}
	}

	async function downloadTranscript() {
		const response = await fetch('/api/download', {
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
		a.download = 'transcript.txt';
		a.click();
	}
</script>

<svelte:head>
	<title>Gemini Transcribe</title>
</svelte:head>

<h1 class="my-2 text-center text-3xl font-bold">Gemini Transcribe</h1>
<main class="mx-auto my-8 grid w-full max-w-lg items-center gap-1.5 p-4 md:p-0">
	{#if uploadComplete}
		<div class="mx-auto my-6 grid w-full max-w-sm items-center gap-1.5">
			{#if fileType === 'audio'}
				<audio src={fileUrl} controls class="mx-auto" bind:this={audioElement} />
			{:else if fileType === 'video'}
				<video src={fileUrl} controls class="mx-auto" bind:this={videoElement} />
			{/if}
		</div>

		<button
			on:click={downloadTranscript}
			class="mt-2 rounded bg-green-500 px-4 py-2 text-white shadow-md transition duration-300 ease-in-out hover:bg-green-700"
		>
			Download transcript
		</button>
	{:else}
		<Label for="audio-file">Audio or video file</Label>
		<Input type="file" on:input={handleFileInput} id="audio-file" accept="audio/*,video/*" />
		<button
			on:click={handleSubmit}
			class="mt-4 rounded bg-blue-500 px-4 py-2 text-white disabled:cursor-not-allowed disabled:bg-gray-400"
			disabled={!selectedFile || isUploading}>Upload File</button
		>
		{#if isUploading}
			<p>Processing file - this may take a few minutes.</p>
		{/if}
	{/if}

	<div class="mb-2">
		{buffer}
	</div>

	<div class="transcript">
		{#each transcriptArray as entry}
			<div class="mb-3">
				<button
					class="rounded bg-blue-500 px-3 py-1 text-sm font-bold text-white shadow-md transition duration-300 ease-in-out hover:bg-blue-700"
					on:click={() => handleTimestampClick(entry.timestamp)}
				>
					{entry.timestamp}
				</button>
				<span class="mr-1 font-bold">{entry.speaker}:</span>
				<span class="text leading-3">{entry.text}</span>
			</div>
		{/each}
	</div>
</main>
