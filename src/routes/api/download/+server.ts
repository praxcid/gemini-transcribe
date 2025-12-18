import { Document, Packer, Paragraph, TextRun } from 'docx';

export async function POST({ request }) {
	const { transcript, timestamps, filename = 'transcript', format = 'txt' } = await request.json();

	if (format === 'docx') {
		const sections: any[] = [];

		transcript.forEach((entry: { timestamp: string; speaker: string; text: string }) => {
			const lines = [];
			if (timestamps) {
				lines.push(new TextRun({ text: '[' + entry.timestamp + '] ', bold: true }));
			}
			lines.push(new TextRun({ text: entry.speaker + ': ', bold: true }));
			lines.push(new TextRun({ text: entry.text }));

			const paragraph = new Paragraph({ children: lines });
			sections.push(paragraph);
		});

		const doc = new Document({ sections: [{ children: sections }] });
		const buffer = await Packer.toBuffer(doc);

		const headers = new Headers();
		headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
		headers.set('Content-Disposition', 'attachment; filename="' + filename + '.docx"');

		return new Response(buffer, { headers });
	}

	// default: plain text
	let formattedTranscript;

	if (timestamps) {
		formattedTranscript = transcript
			.map((entry) => {
				return '[' + entry.timestamp + '] ' + entry.speaker + ': ' + entry.text;
			})
			.join('\n\n');
	} else {
		formattedTranscript = transcript
			.map((entry) => {
				return entry.speaker + ': ' + entry.text;
			})
			.join('\n\n');
	}

	const headers = new Headers();
	headers.set('Content-Type', 'text/plain');
	headers.set('Content-Disposition', 'attachment; filename="' + filename + '.txt"');

	return new Response(formattedTranscript, { headers });
}
