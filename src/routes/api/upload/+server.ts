import { json } from '@sveltejs/kit';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { file as tempFile } from 'tmp-promise';
import { writeFile } from 'fs/promises';
import { GOOGLE_API_KEY } from '$env/static/private';

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	for await (const chunk of stream) {
		console.log(chunk.text());
		yield chunk.text();
	}
}

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file');

	// Check file is .wav or .mp3. If not, return error.

	if (!file.name.endsWith('.wav') && !file.name.endsWith('.mp3')) {
		return new Response('File must be .wav or .mp3', { status: 400 });
	}

	let tempFileHandle;
	let audioFile;

	// Upload audio file
	// try {
	// 	tempFileHandle = await tempFile({ postfix: `.${file.name.split('.').pop()}` });

	// 	const arrayBuffer = await file.arrayBuffer();
	// 	await writeFile(tempFileHandle.path, Buffer.from(arrayBuffer));

	// 	const fileManager = new GoogleAIFileManager(GOOGLE_API_KEY);
	// 	audioFile = await fileManager.uploadFile(tempFileHandle.path, {
	// 		mimeType: file.type
	// 	});
	// } catch (error) {
	// 	console.error(error);
	// 	return new Response('Error uploading file', { status: 500 });
	// } finally {
	// 	if (tempFileHandle) {
	// 		tempFileHandle.cleanup();
	// 	}
	// }

	// console.log(audioFile);

	// Generate transcript

	const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

	const model = genAI.getGenerativeModel({
		model: 'gemini-1.5-flash',
		generationConfig: { responseMimeType: 'application/json' }
	});

	const result = await model.generateContentStream([
		{
			fileData: {
				mimeType: file.type,
				// fileUri: audioFile.file.uri
				fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/wc4623it7ab7'
			}
		},
		{
			text: `Generate a transcript for this audio presentation in 1 minute blocks using this JSON schema: 
     [{"timestamp": "00:00:00", "speaker": "Speaker 1", "text": "Hello, world!"},{"timestamp": "00:01:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."}]`
		}
	]);

	// console.log(result.response);
	// console.log('text: ', result.response.text());

	// return json({ message: 'Success' });

	return new Response(streamChunks(result.stream), {
		headers: {
			'Content-Type': 'text/plain',
			'Transfer-Encoding': 'chunked',
			'X-Content-Type-Options': 'nosniff'
		}
	});

	return json({ message: `File uploaded: ${file.name}` });
}
