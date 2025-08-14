interface TranscriptEntry { timestamp: string; speaker: string; text: string }

export async function POST({ request }) {
	const { transcript, timestamps, separateSpeakers } = await request.json();
	let formattedTranscript: string;

	if (timestamps) {
		formattedTranscript = (transcript as TranscriptEntry[])
			.map((entry: TranscriptEntry) => {
				return separateSpeakers
					? `[${entry.timestamp}]\n[${entry.speaker}]\n${entry.text}`
					: `[${entry.timestamp}]\n${entry.text}`;
			})
			.join('\n\n');
	} else {
		formattedTranscript = (transcript as TranscriptEntry[])
			.map((entry: TranscriptEntry) => {
				return separateSpeakers ? `[${entry.speaker}]\n${entry.text}` : `${entry.text}`;
			})
			.join('\n\n');
	}

	// Enhanced Word-friendly HTML with simple styling
	const escapedBlocks = formattedTranscript
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.split(/\n\n+/);
	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Transcript</title>
	<style>
	body{font-family:Segoe UI,Tahoma,Arial,sans-serif;line-height:1.4;font-size:12pt;}
	h1{font-size:18pt;margin-bottom:12pt;border-bottom:2px solid #444;padding-bottom:4pt;}
	.ts{color:#555;font-weight:bold;margin-right:6pt;}
	.spk{color:#1d4ed8;font-weight:bold;margin-right:4pt;}
	.block{margin:0 0 10pt 0;}
	</style></head><body><h1>Transcript</h1>${escapedBlocks
		.map((block) => {
			const lines = block.split(/\n/);
			const htmlLines = lines
				.map((l) => l.replace(/\[(\d{2}:\d{2})\]/, '<span class="ts">[$1]</span>')
					.replace(/\[(Speaker \d+)\]/, '<span class="spk">$1</span>'))
				.join('<br>');
			return `<p class="block">${htmlLines}</p>`;
		})
		.join('')}</body></html>`;

	const headers = new Headers();
	headers.set('Content-Type', 'application/msword');
	headers.set('Content-Disposition', 'attachment; filename="transcript.doc"');

	return new Response(html, { headers });
}
