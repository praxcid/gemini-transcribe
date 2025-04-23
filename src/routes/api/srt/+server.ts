// Helper function to parse "mm:ss" string into total seconds (number)
function parseMmSsToSeconds(timeString: string) {
	const parts = timeString.split(':');

	if (parts.length !== 2) {
		console.warn(`Invalid timestamp format received: "${timeString}". Expected "mm:ss".`);
		return NaN;
	}

	const minutes = parseInt(parts[0], 10);
	const seconds = parseInt(parts[1], 10);

	if (isNaN(minutes) || isNaN(seconds)) {
		console.warn(`Could not parse numbers from timestamp: "${timeString}".`);
		return NaN;
	}

	return minutes * 60 + seconds;
}

// Helper function to format total seconds (number) into HH:MM:SS,ms string
function formatTime(totalSeconds: number) {
	const date = new Date(0);
	date.setMilliseconds(totalSeconds * 1000);

	const hours = String(date.getUTCHours()).padStart(2, '0');
	const minutes = String(date.getUTCMinutes()).padStart(2, '0');
	const secs = String(date.getUTCSeconds()).padStart(2, '0');
	const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');

	return `${hours}:${minutes}:${secs},${milliseconds}`;
}

export async function POST({ request }) {
	try {
		const { transcript } = await request.json();

		let srtContent = '';
		const defaultDuration = 3; // Default duration in seconds for the last segment

		for (let i = 0; i < transcript.length; i++) {
			const entry = transcript[i];

			// Skip invalid entries
			if (
				typeof entry.text !== 'string' ||
				typeof entry.timestamp !== 'string' ||
				typeof entry.speaker !== 'string'
			) {
				console.warn(`Skipping entry with missing/invalid fields at index ${i}:`, entry);
				continue;
			}

			const startTimeSeconds = parseMmSsToSeconds(entry.timestamp);

			// Check if parsing failed
			if (isNaN(startTimeSeconds)) {
				console.warn(
					`Skipping entry due to invalid timestamp format at index ${i}: "${entry.timestamp}"`
				);
				continue;
			}

			// Determine end time
			let endTimeSeconds;
			if (i < transcript.length - 1) {
				const nextEntry = transcript[i + 1];
				// Check if next entry and its timestamp are valid before parsing
				if (nextEntry && typeof nextEntry.timestamp === 'string') {
					const nextStartTimeSeconds = parseMmSsToSeconds(nextEntry.timestamp);

					// Check if next timestamp parsed correctly AND is chronologically after current
					if (!isNaN(nextStartTimeSeconds) && nextStartTimeSeconds > startTimeSeconds) {
						endTimeSeconds = nextStartTimeSeconds;
					} else {
						// Fallback if next timestamp is invalid, fails parsing, or is not later
						console.warn(
							`Invalid, out-of-order, or unparsable timestamp for next entry at index ${i + 1} ("${nextEntry.timestamp}"). Using default duration for entry ${i}.`
						);
						endTimeSeconds = startTimeSeconds + defaultDuration;
					}
				} else {
					// Fallback if next entry or its timestamp field is invalid
					console.warn(
						`Invalid next entry or timestamp field at index ${i + 1}. Using default duration for entry ${i}.`
					);
					endTimeSeconds = startTimeSeconds + defaultDuration;
				}
			} else {
				endTimeSeconds = startTimeSeconds + defaultDuration;
			}

			const startTimeFormatted = formatTime(startTimeSeconds);
			const endTimeFormatted = formatTime(endTimeSeconds);

			const subtitleText = entry.text;

			// Construct the SRT block
			srtContent += `${i + 1}\n`;
			srtContent += `${startTimeFormatted} --> ${endTimeFormatted}\n`;
			srtContent += `${subtitleText}\n\n`;
		}

		const headers = new Headers();
		headers.set('Content-Type', 'text/srt; charset=utf-8');
		headers.set('Content-Disposition', 'attachment; filename="transcript.srt"');

		return new Response(srtContent, { headers });
	} catch (error) {
		console.error('Error processing request:', error);
		if (error instanceof SyntaxError) {
			return new Response('Invalid JSON body.', { status: 400 });
		}
		return new Response('An internal server error occurred.', { status: 500 });
	}
}
