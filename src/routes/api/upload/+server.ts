import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { file as tempFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';

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

	const formData = await request.formData();
	const file = formData.get('file') as File;
	const language = (formData.get('language') as string) || 'English';

	let tempFileHandle;
	let uploadResult;

	const fileManager = new GoogleAIFileManager(env.GOOGLE_API_KEY);

	// Upload file
	try {
		tempFileHandle = await tempFile({ postfix: `.${file.name.split('.').pop()}` });

		await pipeline(file.stream(), createWriteStream(tempFileHandle.path));
		uploadResult = await fileManager.uploadFile(tempFileHandle.path, {
			mimeType: file.type
		});
	} catch (error) {
		console.error(error);
		return new Response('Error uploading file', { status: 500 });
	} finally {
		if (tempFileHandle) {
			tempFileHandle.cleanup();
		}
	}

	console.log(uploadResult);

	// Generate transcript
	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

	try {
		// Check that the file has been processed
		let uploadedFile = await fileManager.getFile(uploadResult.file.name);

		let retries = 0;
		const maxRetries = 3;
		const initialRetryDelay = 1000; // 1 second

		while (uploadedFile.state === FileState.PROCESSING) {
			console.log('File is processing... waiting 5 seconds before next poll.');
			await new Promise((resolve) => setTimeout(resolve, 5000));

			try {
				uploadedFile = await fileManager.getFile(uploadResult.file.name);
				retries = 0; // Reset retries on a successful API call
			} catch (error) {
				// Check if it's a 5xx error eligible for retry
				if (error instanceof Error && error.message.includes('500 Internal Server Error')) {
					retries++;
					if (retries > maxRetries) {
						console.error(`Transcription API failed after ${maxRetries} retries.`, error);
						throw new Error('Transcription API is currently unavailable. Please try again later.');
					}

					const delay = initialRetryDelay * Math.pow(2, retries - 1); // 1s, 2s, 4s
					console.warn(
						`Transcription API error during polling, retrying in ${delay}ms... (Attempt ${retries}/${maxRetries})`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
					continue;
				} else {
					// Not a retryable error, throw it to the outer catch block
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
			mimeType: file.type,
			fileUri: uploadResult.file.uri
		};

		let result;
		try {
			// Try with the primary model first
			console.log('Attempting transcription with gemini-2.5-flash');
			result = await generateTranscriptWithModel(genAI, 'gemini-2.5-flash', fileData, language);
		} catch (error) {
			// Check if it's a 429 error (rate limit)
			if (
				error instanceof Error &&
				(error.message.includes('429') || error.message.includes('rate limit'))
			) {
				console.warn(
					'Primary model rate limited, falling back to gemini-2.5-flash-lite-preview-09-2025'
				);
				try {
					result = await generateTranscriptWithModel(
						genAI,
						'gemini-2.5-flash-lite-preview-09-2025',
						fileData,
						language
					);
				} catch (fallbackError) {
					console.error('Fallback model also failed:', fallbackError);
					throw fallbackError;
				}
			} else {
				// Not a 429 error, re-throw the original error
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
