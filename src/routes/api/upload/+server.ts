import { json } from '@sveltejs/kit';

export async function POST({ request }) {
	const formData = await request.formData();
	const file = formData.get('file');

	return json({ message: `File uploaded: ${file.name}` });
}
