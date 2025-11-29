import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { file as tempFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';
import { Readable } from 'node:stream';
import Busboy from 'busboy';

// Rate limiting disabled for now
// const requests = new Map<string, { count: number; expires: number }>();
// const RATE_LIMIT = 5;
// const DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	for await (const chunk of stream) {
		yield chunk.text();
	}
}

async function generateTranscriptWithModel(genAI, modelName, fileData, language) {
	const model = genAI.getGenerativeModel({
		model: modelName,
		safetySettings,
		generationConfig: { responseMimeType: 'application/json' }
	});

	const result = await model.generateContentStream([
		{
			fileData: {
				mimeType: fileData.mimeType,
				fileUri: fileData.fileUri
			}
		},
		{
			text: `Generate a transcript in ${language} for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. Respond with the transcript in the form of this JSON schema:
     [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Today I will be talking about the importance of AI in the modern world."},{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Has AI has revolutionized the way we live and work?"}]`
		}
	]);

	return result;
}

export async function POST(event) {
	// Rate limiting disabled for now
	// const ip = event.getClientAddress();
	// const now = Date.now();
	// let record = requests.get(ip);

	// if (!record || record.expires < now) {
	// 	record = { count: 0, expires: now + DURATION };
	// 	requests.set(ip, record);
	// }

	// if (record.count >= RATE_LIMIT) {
	// 	return new Response(
	// 		'This free service supports up to 5 requests per user per day. Please try again tomorrow.',
	// 		{ status: 429 }
	// 	);
	// }

	const { request } = event;

	const contentType = request.headers.get('content-type');
	if (!contentType || !contentType.startsWith('multipart/form-data')) {
		return new Response('Expected multipart/form-data', { status: 400 });
	}

	// Reject large uploads
	const contentLength = request.headers.get('content-length');
	const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 512MB
	if (contentLength && Number(contentLength) > MAX_UPLOAD_BYTES) {
		return new Response('File too large', { status: 413 });
	}

	// Convert Web ReadableStream to Node Readable
	const nodeReadable = Readable.fromWeb(request.body as any);

	let language = 'English';
	let uploadedFilePath: string | null = null;
	let uploadedFileMime: string | undefined;
	let tempFileHandle;

	const busboy = Busboy({
		headers: {
			'content-type': contentType
		}
	});

	const parsePromise = new Promise<void>((resolve, reject) => {
		busboy.on('field', (fieldname, value) => {
			if (fieldname === 'language') {
				language = value || 'English';
			}
		});

		busboy.on('file', async (fieldname, fileStream, info) => {
			// Only handle the 'file' field
			if (fieldname !== 'file') {
				fileStream.resume(); // discard any other file fields
				return;
			}

			try {
				tempFileHandle = await tempFile({
					postfix: info.filename.includes('.') ? `.${info.filename.split('.').pop()}` : ''
				});
				uploadedFilePath = tempFileHandle.path;
				uploadedFileMime = info.mimeType;

				await pipeline(fileStream, createWriteStream(tempFileHandle.path));
			} catch (err) {
				reject(err);
			}
		});

		busboy.on('error', (err) => reject(err));
		busboy.on('finish', () => resolve());
	});

	nodeReadable.pipe(busboy);

	try {
		await parsePromise;
	} catch (err) {
		console.error('Error parsing multipart body:', err);
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('Error uploading file', { status: 500 });
	}

	if (!uploadedFilePath || !uploadedFileMime) {
		if (tempFileHandle) tempFileHandle.cleanup();
		return new Response('No file uploaded', { status: 400 });
	}

	const fileManager = new GoogleAIFileManager(env.GOOGLE_API_KEY);

	let uploadResult;
	try {
		uploadResult = await fileManager.uploadFile(uploadedFilePath, {
			mimeType: uploadedFileMime
		});
	} catch (error) {
		console.error(error);
		return new Response('Error uploading file', { status: 500 });
	} finally {
		if (tempFileHandle) {
			tempFileHandle.cleanup();
		}
	}

	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

	try {
		// Poll until the file is processed
		let uploadedFile = await fileManager.getFile(uploadResult.file.name);

		let retries = 0;
		const maxRetries = 3;
		const initialRetryDelay = 1000;

		while (uploadedFile.state === FileState.PROCESSING) {
			console.log('File is processing... waiting 5 seconds before next poll.');
			await new Promise((resolve) => setTimeout(resolve, 5000));

			try {
				uploadedFile = await fileManager.getFile(uploadResult.file.name);
				retries = 0;
			} catch (error) {
				if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
					retries++;
					if (retries > maxRetries) {
						console.error(`Transcription API failed after ${maxRetries} retries.`, error);
						throw new Error('Transcription API is currently unavailable. Please try again later.');
					}

					const delay = initialRetryDelay * Math.pow(2, retries - 1);
					console.warn(
						`Transcription API error during polling, retrying in ${delay}ms... (Attempt ${retries}/${maxRetries})`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				} else {
					console.error('Unhandled error during file polling:', error);
					throw error;
				}
			}
		}

		if (uploadedFile.state === FileState.FAILED) {
			console.error('File processing failed for:', uploadedFile);
			return new Response(
				"Unfortunately this file couldn't be processed. The file may be corrupt or in an unsupported format.",
				{ status: 500 }
			);
		}

		const fileData = {
			mimeType: uploadedFileMime,
			fileUri: uploadResult.file.uri
		};

		let result;
		try {
			console.log('Attempting transcription with gemini-2.5-flash');
			result = await generateTranscriptWithModel(genAI, 'gemini-2.5-flash', fileData, language);
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes('429') ||
					error.message.includes('rate limit') ||
					error.message.includes('503'))
			) {
				console.warn(
					'Primary model unavailable or rate limited, falling back to gemini-2.5-flash-lite-preview'
				);
				result = await generateTranscriptWithModel(
					genAI,
					'gemini-2.5-flash-lite-preview-09-2025',
					fileData,
					language
				);
			} else {
				throw error;
			}
		}

		// Rate limiting disabled for now
		// record.count++;
		// requests.set(ip, record);

		return new Response(streamChunks(result.stream), {
			headers: {
				'Content-Type': 'text/plain',
				'Transfer-Encoding': 'chunked',
				'X-Content-Type-Options': 'nosniff'
			}
		});
	} catch (error) {
		console.error('Error during transcription process:', error);
		return new Response(
			'Sorry, something went wrong generating the transcript. Please try again later.',
			{ status: 500 }
		);
	}
}
