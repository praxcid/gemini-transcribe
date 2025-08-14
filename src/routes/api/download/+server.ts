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

	// Wrap in minimal HTML so Word interprets formatting; use <p> blocks
	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Transcript</title></head><body>${formattedTranscript
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.split(/\n\n+/)
		.map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`) // preserve single line breaks
		.join('')} </body></html>`;

	const headers = new Headers();
	headers.set('Content-Type', 'application/msword');
	headers.set('Content-Disposition', 'attachment; filename="transcript.doc"');

	return new Response(html, { headers });
}
