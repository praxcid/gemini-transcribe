import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { file as tempFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { env } from '$env/dynamic/private';
import { safetySettings } from '$lib/index';

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	for await (const chunk of stream) {
		yield chunk.text();
	}
}

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file') as File;
	const language = (formData.get('language') as string) || 'English';
	const requestedModel = (formData.get('model') as string) || 'gemini-2.5-flash';
	const separateSpeakers = (formData.get('separateSpeakers') as string) === 'true';
	const medicalMode = (formData.get('medicalMode') as string) === 'true';
	// Optional custom style / vocabulary context extracted from uploaded Word docs (.docx/.txt) on the client
	const styleContext = (formData.get('styleContext') as string) || '';

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

	// Basic allow-list to prevent arbitrary model names
	const allowedModels = new Set([
		'gemini-2.5-flash',
		'gemini-2.5-pro',
		'gemini-1.5-flash',
		'gemini-1.5-pro'
	]);
	const modelName = allowedModels.has(requestedModel) ? requestedModel : 'gemini-2.5-flash';
	const model = genAI.getGenerativeModel({
		model: modelName,
		safetySettings,
		generationConfig: { responseMimeType: 'application/json' }
	});

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

		// Build adaptive instruction including optional style context (truncated server-side as safety)
		const trimmedStyle = styleContext?.slice(0, 20000); // cap to ~20k chars to protect token budget
		const styleInstruction = trimmedStyle
			? `\nIncorporate the following reference vocabulary, names, jargon, spellings and stylistic preferences where they clearly match the spoken audio (do NOT hallucinate terms not actually spoken). If a word in audio is ambiguous but a close match appears in this list, prefer the list's spelling. Reference style (do not output this list):\n---REFERENCE START---\n${trimmedStyle}\n---REFERENCE END---\n`
			: '';

		const result = await model.generateContentStream([
			{
				fileData: {
					mimeType: file.type,
					fileUri: uploadResult.file.uri
				}
			},
			{
				text: `Generate a ${medicalMode ? 'medical ' : ''}transcript in ${language} for this file. Always use the format mm:ss for the time. Group similar text together rather than timestamping every line. ${separateSpeakers ? 'Identify and label distinct speakers as Speaker 1, Speaker 2, etc. Keep speaker labels consistent across the transcript.' : 'Do not attempt to identify multiple speakers; use a single speaker label Speaker 1 for all lines.'} ${medicalMode ? 'Act as a professional medical transcriptionist: accurately capture clinical terminology, medication names, dosages, procedures, anatomical terms, lab values, and patient instructions. Prefer precise standardized medical terminology (e.g., myocardial infarction instead of heart attack, hypertension instead of high blood pressure) when the audio clearly implies it, but faithfully reproduce verbatim any explicit layperson wording actually spoken. Do not invent or infer diagnoses or values not stated. Do not paraphrase patient speech; only substitute more clinical terms for obvious lay paraphrases when medically unambiguous. Expand unclear abbreviations only when medically unambiguous.' : ''} Avoid all contractions; always expand them fully (e.g., don't -> do not, can't -> cannot, it's -> it is, I'm -> I am, shouldn't -> should not, hasn't -> has not). Preserve exact proper nouns and acronyms. ${language === 'Australian English' ? ' Use Australian/British spellings (e.g., colour, organisation, centre, labour, paediatric, anaemia, haemorrhage, oesophagus, foetal, judgement, practise (verb sense), programme (when non-IT organisational usage), theatre) and avoid American variants (color, organization, center, labor, pediatric, anemia, hemorrhage, esophagus, fetal, judgment (retain Australian judgement), practice (verb), program (non-IT), theater) unless clearly spoken that way.' : ''}${styleInstruction}Respond with the transcript in the form of this JSON schema:
    [{"timestamp": "00:00", "speaker": "Speaker 1", "text": "Chief complaint: patient presents with intermittent chest pain over the past 3 days."},{"timestamp": "01:00", "speaker": "Speaker 1", "text": "Current medications include atorvastatin 20 milligrams daily and metformin 500 milligrams twice daily."}]`
			}
		]);

		const readable = new ReadableStream({
			async start(controller) {
				for await (const chunk of result.stream) {
					// Each chunk may have a .text() method similar to earlier logic
					// Normalize to string
					// @ts-ignore - dynamic chunk shape
					const textPart = typeof chunk === 'string' ? chunk : (await chunk.text?.()) ?? '';
					if (textPart) controller.enqueue(new TextEncoder().encode(textPart));
				}
				controller.close();
			}
		});

		return new Response(readable, {
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
