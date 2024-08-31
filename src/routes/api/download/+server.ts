export async function POST({ request }) {
	const { transcript } = await request.json();

	const formattedTranscript = transcript
		.map((entry) => {
			return `[${entry.timestamp}]\n[${entry.speaker}]\n${entry.text}`;
		})
		.join('\n\n');

	const headers = new Headers();
	headers.set('Content-Type', 'text/plain');
	headers.set('Content-Disposition', 'attachment; filename="transcript.txt"');

	return new Response(formattedTranscript, { headers });
}
