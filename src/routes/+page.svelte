<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let selectedFile: File | null = null;
	let uploadComplete = false;
	let audioUrl: string | null = null;

	let buffer = '';
	let transcriptArray: Array<{ timestamp: string; speaker: string; text: string }> = [];

	// $: paragraphs = transcript.split('\n\n');

	// function splitParagraph(paragraph) {
	// 	const match = paragraph.match(/^(## \[.*?\])(.*)$/s);
	// 	if (match) {
	// 		return {
	// 			timestamp: match[1].trim(),
	// 			content: match[2].trim()
	// 		};
	// 	}
	// 	return { content: paragraph.trim() };
	// }

	function handleFileInput(event: Event) {
		const target = event.target as HTMLInputElement;
		selectedFile = target.files?.[0] ?? null;
		if (selectedFile) {
			audioUrl = URL.createObjectURL(selectedFile);
		}
	}

	async function handleSubmit() {
		if (!selectedFile) return;

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
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			try {
				const jsonChunk = JSON.parse(buffer.trim());
				transcriptArray = [...transcriptArray, ...jsonChunk];
				buffer = '';
			} catch (error) {
				// console.error('Error parsing JSON:', error);
			}
		}
	}
</script>

<h1 class="my-2 text-center text-3xl font-bold">Transcribe</h1>
<main class="mx-auto my-8 grid w-full max-w-sm items-center gap-1.5">
	{#if uploadComplete}
		<div class="mx-auto my-8 grid w-full max-w-sm items-center gap-1.5">
			<audio src={audioUrl} controls class="mx-auto" />
		</div>
	{:else}
		<Label for="audio-file">Audio file</Label>
		<Input type="file" on:input={handleFileInput} id="audio-file" />
		<button on:click={handleSubmit} class="mt-4 rounded bg-blue-500 px-4 py-2 text-white"
			>Upload File</button
		>
	{/if}
	<p>Buffer: {buffer}</p>

	<!-- TODO: format transcript array nicely -->
	<p>{JSON.stringify(transcriptArray)}</p>

	<!-- <div class="transcript">
		{#each transcript as entry}
			<div class="entry">
				<span class="timestamp">{entry.timestamp}</span>
				<span class="speaker">{entry.speaker}:</span>
				<span class="text">{entry.text}</span>
			</div>
		{/each}
	</div> -->
</main>

<style>
	.transcript {
		font-family: Arial, sans-serif;
		max-width: 800px;
		margin: 0 auto;
	}
	.entry {
		margin-bottom: 10px;
	}
	.timestamp {
		color: #888;
		font-size: 0.8em;
		margin-right: 10px;
	}
	.speaker {
		font-weight: bold;
		margin-right: 5px;
	}
	.text {
		line-height: 1.4;
	}
</style>
