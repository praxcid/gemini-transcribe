<script lang="ts">
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';

	let selectedFile: File | null = null;
	let uploadComplete = false;
	let audioUrl: string | null = null;

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

		try {
			const response = await fetch('/api/upload', {
				method: 'POST',
				body: formData
			});

			const data = await response.json();
			console.log(data);

			uploadComplete = true;
		} catch (error) {
			console.error('Error uploading file:', error);
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
</main>
