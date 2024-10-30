import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { safetySettings } from '$lib/index';

export async function POST({ request }) {
	const { buffer } = await request.json();

	const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);

	const model = genAI.getGenerativeModel({
		model: 'gemini-1.5-flash-exp-0827',
		safetySettings,
		generationConfig: { responseMimeType: 'application/json' }
	});

	const prompt = `Fix this poorly formatted JSON buffer. Return an object with a key of "formattedJSON". \n\n BUFFER: ${buffer}`;

	const result = await model.generateContent(prompt);

	const { formattedJSON } = JSON.parse(result.response.text());

	return json({ formattedJSON });
}
