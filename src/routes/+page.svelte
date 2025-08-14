<script lang="ts">
import { onMount } from 'svelte';
import { Input } from '$lib/components/ui/input/index.js';
import { Label } from '$lib/components/ui/label/index.js';
import { IncrementalTranscriptParser } from '$lib/stream-parser';

let selectedFiles: File[] = [];
let uploadComplete = false;
let isUploading = false;
let fileUrls: string[] = [];
let fileTypes: ('audio' | 'video')[] = [];

let streamBuffers: string[] = [];
let transcripts: Array<Array<{ timestamp: string; speaker: string; text: string }>> = [];
let perFileUploadProgress: number[] = [];
let language = 'English';
let separateSpeakers = true;
let showTimestamps = false;
let medicalMode = true;
let model = 'gemini-2.5-flash';
let initialized = false;
// Style / vocabulary documents (.docx or .txt) to guide transcription
let styleDocs: File[] = [];
let extractedStyleText = '';
let extracting = false;
let glossaryText = '';
let useGlossary = true; // include glossary terms in prompt
let includeFullStyle = false; // optionally also include full raw style text
let autoBuiltGlossary = false;
let styleSummary = '';
let adaptStyle = true; // apply formatting/style tendencies from docs

// Contraction expansion map (lowercase keys)
const contractionMap: Record<string, string> = {
	"don't": 'do not',
	"doesn't": 'does not',
	"didn't": 'did not',
	"can't": 'cannot',
	"cannot": 'cannot',
	"won't": 'will not',
	"wouldn't": 'would not',
	"shouldn't": 'should not',
	"couldn't": 'could not',
	"isn't": 'is not',
	"aren't": 'are not',
	"wasn't": 'was not',
	"weren't": 'were not',
	"haven't": 'have not',
	"hasn't": 'has not',
	"hadn't": 'had not',
	"i'm": 'I am',
	"i've": 'I have',
	"i'd": 'I would',
	"i'll": 'I will',
	"you're": 'you are',
	"you've": 'you have',
	"you'd": 'you would',
	"you'll": 'you will',
	"he's": 'he is',
	"she's": 'she is',
	"it's": 'it is',
	"we're": 'we are',
	"we've": 'we have',
	"we'd": 'we would',
	"we'll": 'we will',
	"they're": 'they are',
	"they've": 'they have',
	"they'd": 'they would',
	"they'll": 'they will',
	"that's": 'that is',
	"there's": 'there is',
	"there're": 'there are',
	"what's": 'what is',
	"who's": 'who is',
	"where's": 'where is',
	"when's": 'when is',
	"why's": 'why is',
	"how's": 'how is',
	"let's": 'let us',
	"mustn't": 'must not',
	"mightn't": 'might not',
	"shan't": 'shall not',
	"oughtn't": 'ought not'
};

function expandContractions(text: string): string {
	// Replace using regex word boundary, case-insensitive; preserve capitalization of first letter.
	return text.replace(/\b[\w']+\b/gi, (token) => {
		const lower = token.toLowerCase();
		if (contractionMap[lower]) {
			const expansion = contractionMap[lower];
			// If original token was capitalized (first char uppercase, rest lowercase/apostrophes), capitalize expansion's first letter.
			if (/^[A-Z][a-z']*$/.test(token) && /[a-z]/.test(token.slice(1))) {
				return expansion.charAt(0).toUpperCase() + expansion.slice(1);
			}
			return expansion;
		}
		return token;
	});
}

function buildGlossary(source: string) {
	// Basic glossary extraction heuristics:
	// 1. Collect sequences of capitalized words (e.g., Proper Names, Medical Terms) up to length 4
	// 2. Collect standalone ALL-CAPS acronyms (>=2 letters)
	// 3. Collect hyphenated specialized terms preserving case
	// 4. Frequency count; keep top N unique terms (by frequency then length) to limit size
	const text = source.replace(/[^A-Za-z0-9\-\s]/g,' ');
	const tokens = text.split(/\s+/).filter(Boolean);
	const phrases: Record<string, number> = {};
	// Helper to add phrase
	const add = (p: string) => {
		if (p.length < 2) return;
		if (p.length > 120) return;
		phrases[p] = (phrases[p] || 0) + 1;
	};
	// Acronyms & single tokens
	for (const t of tokens) {
		if (/^[A-Z]{2,}$/.test(t)) add(t);
		else if (/^[A-Z][a-z]+[A-Za-z\-]*$/.test(t)) add(t); // Capitalized
		else if (/^[A-Za-z]+\-[A-Za-z]+$/.test(t)) add(t); // hyphenated
	}
	// Multi-word capitalized sequences
	for (let i=0;i<tokens.length;i++) {
		if (!/^[A-Z][a-z]/.test(tokens[i])) continue;
		let phrase = tokens[i];
		for (let j=i+1;j<Math.min(i+4, tokens.length); j++) {
			if (/^[A-Z][a-z]/.test(tokens[j])) {
				phrase += ' ' + tokens[j];
				add(phrase);
			} else break;
		}
	}
	// Convert to sorted list
	const entries = Object.entries(phrases).sort((a,b)=> {
		if (b[1] === a[1]) return a[0].length - b[0].length; // shorter first when same freq
		return b[1]-a[1];
	});
	const MAX_TERMS = 400; // to keep prompt lean
	const selected = entries.slice(0, MAX_TERMS).map(e=>e[0]);
	glossaryText = selected.join('\n');
	autoBuiltGlossary = true;
}

function buildStyleSummary(source: string) {
	// Derive lightweight style metrics and convert to directive text.
	// 1. Sentence metrics
	const sentences = source.split(/(?<=[.!?])\s+/).filter(s=>s.trim().length>0);
	const words = source.split(/\s+/).filter(Boolean);
	const avgSentenceLen = sentences.length ? (words.length / sentences.length) : 0;
	// 2. Bullet style detection
	const lines = source.split(/\n+/).map(l=>l.trim()).filter(Boolean);
	const bulletDash = lines.filter(l=>/^[-–•]/.test(l)).length;
	const bulletNum = lines.filter(l=>/^\d+\./.test(l)).length;
	// 3. Acronym density
	const acronyms = words.filter(w=>/^[A-Z]{2,}$/.test(w));
	const acronymRatio = words.length ? (acronyms.length / words.length) : 0;
	// 4. Common casing preferences (e.g., Title Case vs sentence case)
	const capitalizedStarts = sentences.filter(s=>/^[A-Z][a-z]+/.test(s.trim())).length;
	// 5. Hyphen usage frequency
	const hyphenated = words.filter(w=>/^[A-Za-z]+\-[A-Za-z]+$/.test(w)).length;
	// 6. Colon usage (lists, headings)
	const colonCount = (source.match(/:/g)||[]).length;
	// Compose guidelines
	const parts: string[] = []; parts.push('Emulate stylistic tendencies found in reference docs while preserving factual accuracy of audio and not hallucinating.');
	if (avgSentenceLen) parts.push(`Average sentence length target: ${Math.round(avgSentenceLen)} words (adjust only if natural).`);
	if (bulletDash > bulletNum && bulletDash > 3) parts.push('When listing items, prefer dash/• style bullet lines.');
	if (bulletNum > bulletDash && bulletNum > 3) parts.push('When listing items, prefer numbered lists.');
	if (acronymRatio > 0.02) parts.push('Expand or retain domain acronyms exactly as spoken; ensure consistent capitalization for acronyms.');
	if (hyphenated > 5) parts.push('Preserve hyphenated compound terms as in reference (e.g., cardio-vascular style).');
	if (colonCount > sentences.length * 0.2) parts.push('Use colons sparingly to introduce explanations or lists per reference style.');
	if (capitalizedStarts / sentences.length > 0.9) parts.push('Maintain standard capitalization at sentence starts.');
	parts.push('Do not rewrite meaning. Maintain verbatim clinical or technical terminology accuracy.');
	styleSummary = 'STYLE GUIDELINES:\n' + parts.join('\n');
	if (styleSummary.length > 1500) styleSummary = styleSummary.slice(0,1500);
}

let audioElements: (HTMLAudioElement | null)[] = [];
let videoElements: (HTMLVideoElement | null)[] = [];
let fileDurations: number[] = [];
let userChangedModel = false;
let fileInputEl: HTMLInputElement | null = null;
let showDocSummary = true;
let darkMode = false;

const modelInfo: Record<string, { speed: string; quality: string; bestFor: string; notes?: string }> = {
	'gemini-2.5-flash': { speed: 'Very fast', quality: 'Good', bestFor: 'Long or many files', notes: 'Lower cost, optimized latency.' },
	'gemini-2.5-pro': { speed: 'Moderate', quality: 'Highest', bestFor: 'Short high-accuracy tasks', notes: 'Best accuracy for nuanced medical terms.' },
	'gemini-1.5-flash': { speed: 'Fast', quality: 'Good', bestFor: 'Legacy compatibility', notes: 'Older generation fast model.' },
	'gemini-1.5-pro': { speed: 'Moderate', quality: 'High', bestFor: 'Fallback high-quality', notes: 'Prior-gen Pro model.' }
};

onMount(() => {
	language = localStorage.getItem('transcriptionLanguage') || 'English';
	model = localStorage.getItem('aiModel') || 'gemini-2.5-flash';
	if (model === 'gemini-2.0-pro-exp') model = 'gemini-2.5-pro';
	userChangedModel = !!localStorage.getItem('aiModel');
	const storedSeparate = localStorage.getItem('separateSpeakers');
	if (storedSeparate !== null) separateSpeakers = storedSeparate === 'true';
	const storedShowTimestamps = localStorage.getItem('showTimestamps');
	if (storedShowTimestamps !== null) showTimestamps = storedShowTimestamps === 'true';
	initialized = true;
});

$: if (initialized) {
	localStorage.setItem('transcriptionLanguage', language);
	localStorage.setItem('separateSpeakers', String(separateSpeakers));
	localStorage.setItem('showTimestamps', String(showTimestamps));
	localStorage.setItem('aiModel', model);
}

function toggleDark() {
	darkMode = !darkMode;
	if (darkMode) document.documentElement.classList.add('dark');
	else document.documentElement.classList.remove('dark');
}

function handleTimestampClick(timestamp: string, index: number) {
	const parts = timestamp.split(':').map(Number);
	let time = 0;
	if (parts.length === 3) time = parts[0] * 3600 + parts[1] * 60 + parts[2];
	else if (parts.length === 2) time = parts[0] * 60 + parts[1];
	const a = audioElements[index];
	if (a) { a.currentTime = time; a.play(); }
	const v = videoElements[index];
	if (v) { v.currentTime = time; v.play(); }
}

function handleFileInput(event: Event) {
	const target = event.target as HTMLInputElement;
	const inputFiles = Array.from(target.files ?? []);
	if (!inputFiles.length) return;
	selectedFiles = inputFiles;
	fileUrls = selectedFiles.map(f => URL.createObjectURL(f));
	fileTypes = selectedFiles.map(f => f.type.includes('audio') ? 'audio' : 'video');
	fileDurations = [];
}

async function handleStyleDocInput(event: Event) {
	const target = event.target as HTMLInputElement;
	const inputFiles = Array.from(target.files ?? []);
	if (!inputFiles.length) return;
	styleDocs = inputFiles;
	extractedStyleText = '';
	extracting = true;
	// Process sequentially to keep it simple
	for (const f of styleDocs) {
		try {
			if (f.name.endsWith('.txt')) {
				extractedStyleText += '\n' + await f.text();
					} else if (f.name.endsWith('.doc')) {
						// Very naive legacy .doc (binary) text extraction: pull printable ASCII/UTF-8 sequences.
						const arrayBuf = await f.arrayBuffer();
						const bytes = new Uint8Array(arrayBuf);
						let current: number[] = [];
						const chunks: string[] = [];
						for (const b of bytes) {
							if (b === 0) continue;
								// Accept common readable ranges
							if (b >= 32 && b <= 126) {
								current.push(b);
								if (current.length > 200) { // flush long run
									chunks.push(String.fromCharCode(...current));
									current = [];
								}
							} else {
								if (current.length >= 4) {
									chunks.push(String.fromCharCode(...current));
								}
								current = [];
							}
						}
						if (current.length >= 4) chunks.push(String.fromCharCode(...current));
						// Filter out obvious noise tokens (e.g., long sequences without spaces)
						const filtered = chunks.filter(c => /[a-zA-Z]/.test(c) && c.split(/\s+/).length > 1);
						extractedStyleText += '\n' + filtered.join(' ');
			}
		} catch (e) {
			console.error('Error extracting style doc', f.name, e);
		}
	}
	// Trim & de-duplicate some whitespace
	extractedStyleText = extractedStyleText.replace(/\s+/g,' ').trim();
		if (extractedStyleText) buildGlossary(extractedStyleText);
			if (extractedStyleText) buildStyleSummary(extractedStyleText);
	extracting = false;
}

function handleModelChange() { userChangedModel = true; }

async function handleSubmit() {
	if (!selectedFiles.length) return;
	isUploading = true;
	transcripts = Array(selectedFiles.length).fill([]);
	streamBuffers = Array(selectedFiles.length).fill('');
	perFileUploadProgress = Array(selectedFiles.length).fill(0);

	await Promise.all(selectedFiles.map(async (file, index) => {
		const fileUrl = fileUrls[index];
		const fileType = fileTypes[index];
		const temp = document.createElement(fileType === 'audio' ? 'audio' : 'video');
		temp.src = fileUrl;
		const duration = await new Promise<number>((resolve, reject) => { temp.onloadedmetadata = () => resolve(temp.duration as number); temp.onerror = reject; });
		fileDurations[index] = duration;
		if (!userChangedModel) {
			const haveAll = fileDurations.filter(d => typeof d === 'number').length === selectedFiles.length;
			if (haveAll) {
				const total = fileDurations.reduce((a,b)=>a+(b||0),0);
				const auto = (selectedFiles.length <=2 && total < 1800) ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
				if (model !== auto) model = auto;
			}
		}
		if (duration >= 7200) { alert(`File "${file.name}" is too long (max 2h).`); return; }
		const formData = new FormData();
		formData.append('file', file);
		formData.append('language', language);
		formData.append('separateSpeakers', String(separateSpeakers));
		formData.append('medicalMode', String(medicalMode));
		formData.append('model', model);
		if (extractedStyleText || glossaryText) {
			const parts: string[] = [];
			if (useGlossary && glossaryText) parts.push('GLOSSARY TERMS (unique / high-signal):\n'+glossaryText);
			if (includeFullStyle && extractedStyleText) parts.push('FULL STYLE TEXT (reference only, do not echo):\n'+extractedStyleText);
			if (adaptStyle && styleSummary) parts.push(styleSummary);
			formData.append('styleContext', parts.join('\n\n'));
		}
		const response = await fetch('/api/upload',{ method:'POST', body: formData, headers:{Connection:'keep-alive'}});
		const reader = response.body?.getReader(); if(!reader) throw new Error('Missing body');
		const decoder = new TextDecoder();
		const parser = new IncrementalTranscriptParser();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					try {
						const parsedAll = JSON.parse(streamBuffers[index] || '[]');
							transcripts[index] = Array.isArray(parsedAll) ? parsedAll.map((e:any)=> ({...e, text: expandContractions(e.text||'')})) : [];
					} catch {
						// fallback fix-json endpoint
						const resp = await fetch('/api/fix-json',{method:'POST', headers:{'Content-Type':'text/plain'}, body: streamBuffers[index]});
						const data = await resp.json();
							transcripts[index] = (data.formattedJSON || []).map((e:any)=> ({...e, text: expandContractions(e.text||'')}));
					}
					break;
				}
				const decoded = decoder.decode(value, { stream: true });
				streamBuffers[index] += decoded;
				const newEntries = parser.push(decoded);
				if (newEntries.length) {
						transcripts[index] = transcripts[index].concat(newEntries.map(e=> ({...e, text: expandContractions(e.text)})));
					const estTotal = Math.max(1, Math.round((fileDurations[index] || 0)/5));
					perFileUploadProgress[index] = Math.min(1, transcripts[index].length / estTotal);
				}
			}
		} finally { reader.cancel(); }
	}));
	uploadComplete = true;
	isUploading = false;
}

async function downloadTranscript({ timestamps = true } = {}) {
	const response = await fetch('/api/download', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ transcript: transcripts.flat(), timestamps, separateSpeakers })});
	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	let baseName = 'transcript';
	if (selectedFiles.length) { const original = selectedFiles[0].name; const lastDot = original.lastIndexOf('.'); baseName = lastDot>0? original.slice(0,lastDot): original; }
	a.href = url; a.download = `${baseName}.doc`; a.click();
}

async function downloadAllZip({ timestamps = false } = {}) {
	if (transcripts.length <= 1) return;
	const response = await fetch('/api/download-all',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ transcripts, timestamps, separateSpeakers, fileNames: selectedFiles.map(f=>f.name) }) });
	if(!response.ok) return; const blob = await response.blob(); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='transcripts.zip'; a.click();
}

async function downloadTranscriptForIndex(index: number,{ timestamps = false } = {}) {
	if (!transcripts[index]?.length) return;
	const response = await fetch('/api/download',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ transcript: transcripts[index], timestamps, separateSpeakers }) });
	if(!response.ok) return; const blob = await response.blob(); const url=URL.createObjectURL(blob); const a=document.createElement('a'); const original=selectedFiles[index]?.name||`transcript_${index+1}`; const lastDot=original.lastIndexOf('.'); const baseName= lastDot>0? original.slice(0,lastDot): original; a.href=url; a.download=`${baseName}.doc`; a.click();
}


function reset() {
	selectedFiles = [];
	uploadComplete = false;
	isUploading = false;
	fileUrls = [];
	streamBuffers = [];
	transcripts = [];
	perFileUploadProgress = [];
	audioElements.forEach(el=>{ if(el){ el.currentTime=0; el.pause(); }});
	videoElements.forEach(el=>{ if(el){ el.currentTime=0; el.pause(); }});
}
</script>

<svelte:head>
	<title>Paragon Transcribe</title>
</svelte:head>

<div class="flex min-h-screen flex-col bg-gradient-to-br from-indigo-50 via-white to-cyan-50 dark:from-slate-900 dark:via-slate-950 dark:to-slate-900">
	<div
		class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiMzNzM2ZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-30"
	></div>

	<main class="container relative z-10 mx-auto flex-grow px-4 py-8">
		<section class="mb-6 text-center flex flex-col items-center gap-4">
			<h1
				class="mb-4 bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-3xl font-bold text-transparent md:text-4xl"
			>
				Paragon Transcribe
			</h1>
			<button on:click={toggleDark} class="text-xs px-3 py-1 rounded-full border border-indigo-300 bg-white/70 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600 hover:bg-indigo-50 dark:hover:bg-slate-700 transition">{darkMode ? 'Light Mode' : 'Dark Mode'}</button>

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
								<!-- Hidden native input retrieval (depends on Input implementation). If not accessible, removal is safe. -->
							</div>
							{#if selectedFiles.length > 0}
								<div class="mt-4">
									<p class="font-medium text-slate-700">Selected files:</p>
									<ul class="list-disc list-inside text-slate-600">
										{#each selectedFiles as file}
											<li class="flex items-center gap-2">
												<span>{file.name}</span>
											</li>
										{/each}
									</ul>
								</div>
							{/if}
						</div>

						<!-- Style / vocabulary documents upload -->
						<div class="border-t border-slate-200 pt-6">
							<Label for="style-docs" class="mb-2 block text-sm font-medium text-slate-700 flex items-center gap-2">
								<span>Optional Style & Vocabulary Docs (.doc / .txt)</span>
							    <span class="text-[10px] font-normal text-slate-500">Helps with consistent names, jargon & spelling</span>
							</Label>
							<Input
								id="style-docs"
								type="file"
								accept=".doc,.txt"
								multiple
								on:input={handleStyleDocInput}
								class="block h-12 w-full rounded-lg border-2 border-emerald-200 bg-white/90 text-sm text-slate-700 shadow-sm backdrop-blur-sm file:mr-4 file:rounded-lg file:border-0 file:bg-gradient-to-r file:from-emerald-600 file:to-teal-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white file:transition-all file:duration-300 hover:file:shadow-lg hover:file:shadow-emerald-500/25 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
							/>
							{#if styleDocs.length}
								<div class="mt-3 space-y-2">
									<p class="text-xs font-medium text-slate-600">Loaded style documents:</p>
									<ul class="text-xs text-slate-600 list-disc list-inside">
										{#each styleDocs as sd}
											<li>{sd.name}</li>
										{/each}
									</ul>
									{#if extracting}
										<p class="text-xs text-emerald-600 flex items-center gap-1"><svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10" stroke-width="2" stroke-opacity="0.25"/><path stroke-width="2" stroke-linecap="round" d="M12 2a10 10 0 0 1 10 10"/></svg>Extracting text…</p>
									{:else if extractedStyleText}
										<div class="space-y-1">
											<p class="text-[10px] text-slate-500">Reference tokens: {Math.min( Math.round(extractedStyleText.split(/\s+/).length), 99999)} words parsed</p>
											<div class="flex flex-wrap gap-4 items-center text-[10px]">
												<label class="flex items-center gap-1"><input type="checkbox" bind:checked={useGlossary} class="h-3 w-3"/>Use glossary</label>
												<label class="flex items-center gap-1"><input type="checkbox" bind:checked={includeFullStyle} class="h-3 w-3"/>Include full text</label>
												<label class="flex items-center gap-1"><input type="checkbox" bind:checked={adaptStyle} class="h-3 w-3"/>Adapt style</label>
												<button type="button" on:click={() => buildGlossary(extractedStyleText)} class="px-2 py-1 rounded bg-emerald-600 text-white">Rebuild glossary</button>
											</div>
											{#if glossaryText}
												<div class="mt-2 border border-emerald-200 bg-emerald-50 rounded p-2 max-h-40 overflow-auto text-[10px] leading-snug">
													<p class="font-semibold mb-1">Glossary ({glossaryText.split(/\n/).length} terms)</p>
													<pre class="whitespace-pre-wrap">{glossaryText}</pre>
												</div>
											{/if}
											{#if adaptStyle && styleSummary}
												<div class="mt-2 border border-indigo-200 bg-indigo-50 rounded p-2 max-h-40 overflow-auto text-[10px] leading-snug">
													<p class="font-semibold mb-1">Derived Style Guidelines</p>
													<pre class="whitespace-pre-wrap">{styleSummary}</pre>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
							{#if extractedStyleText}
								<button type="button" class="mt-2 text-[10px] underline text-emerald-600" on:click={() => { extractedStyleText=''; styleDocs=[]; }}>Clear style context</button>
							{/if}
							{#if extractedStyleText && extractedStyleText.length > 20000}
								<p class="mt-2 text-[10px] text-amber-600">Trimmed to first 20k characters for prompt budget.</p>
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
							<div class="mt-2 rounded-md border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700 flex flex-col gap-1">
								<div class="flex items-center gap-2">
									<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
									<span>Using <strong>{model}</strong> {userChangedModel ? '(manual selection)' : '(auto-selected)'}</span>
								</div>
								{#if modelInfo[model]}
									<div class="grid grid-cols-3 gap-2">
										<span class="font-semibold">Speed:</span><span class="col-span-2">{modelInfo[model].speed}</span>
										<span class="font-semibold">Quality:</span><span class="col-span-2">{modelInfo[model].quality}</span>
										<span class="font-semibold">Best for:</span><span class="col-span-2">{modelInfo[model].bestFor}</span>
									</div>
									{#if modelInfo[model].notes}<p class="text-[10px] text-slate-600">{modelInfo[model].notes}</p>{/if}
								{/if}
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
								<p>📁 Supported formats: MP3, WAV, MP4, AVI & common browser-playable media</p>
								<p>⏱️ Maximum duration: 2 hours per file</p>
								<p class="text-[11px] text-slate-500">Files are processed directly in the browser.</p>
					{#if isUploading && perFileUploadProgress.length}
						<div class="mt-6">
							<p class="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">Transcription progress (heuristic)</p>
							<ul class="space-y-1">
								{#each selectedFiles as file, i}
									<li class="flex items-center gap-2 text-xs">
										<span class="truncate max-w-[160px]">{file.name}</span>
										<span class="flex-1 h-2 rounded bg-slate-200 dark:bg-slate-700 overflow-hidden">
											<span class="block h-full bg-gradient-to-r from-teal-500 to-emerald-500 transition-all" style={`width: ${(perFileUploadProgress[i]*100).toFixed(1)}%`}></span>
										</span>
										<span class="tabular-nums w-10 text-right">{Math.round(perFileUploadProgress[i]*100)}%</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
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