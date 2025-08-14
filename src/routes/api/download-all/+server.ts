import type { RequestHandler } from '@sveltejs/kit';

interface TranscriptEntry {
  timestamp: string;
  speaker: string;
  text: string;
}

export const POST: RequestHandler = async ({ request }) => {
  const { transcripts, timestamps = false, separateSpeakers = true, fileNames = [] } = await request.json();

  if (!Array.isArray(transcripts)) {
    return new Response('Invalid transcripts payload', { status: 400 });
  }

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();

  transcripts.forEach((entries: TranscriptEntry[], idx: number) => {
    if (!Array.isArray(entries)) return;
    const safeFileBase = (fileNames[idx] || `transcript_${idx + 1}`).replace(/\.[^/.]+$/, '');

    const escaped = entries.map((entry) => {
      const esc = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

      let line = '';
      if (timestamps) {
        line += `<span class="ts">${esc(entry.timestamp)}</span> `;
      }
      if (separateSpeakers) {
        line += `<strong class="spk">${esc(entry.speaker)}</strong>: `;
      }
      line += esc(entry.text);
      return line;
    });

    const paragraphs = escaped
      .map((line) => `<p style="margin:0 0 8pt 0;font-family:Segoe UI,Arial,sans-serif;font-size:11pt;line-height:1.4;">${line}</p>`)
      .join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${safeFileBase}</title><style>body{font-family:Segoe UI,Tahoma,Arial,sans-serif;font-size:11pt;line-height:1.4;}h1{font-size:16pt;margin:0 0 14pt 0;border-bottom:2px solid #444;padding-bottom:4pt;} .ts{color:#555;font-weight:bold;margin-right:6pt;} .spk{color:#1d4ed8;font-weight:bold;margin-right:4pt;}</style></head><body><h1>${safeFileBase}</h1>${paragraphs}</body></html>`;
    zip.file(`${safeFileBase}.doc`, html);
  });

  const zipContent = await zip.generateAsync({ type: 'uint8array' });

  const buffer = zipContent.buffer.slice(0) as ArrayBuffer; // ensure ArrayBuffer
  const blob = new Blob([new Uint8Array(buffer)], { type: 'application/zip' });
  return new Response(blob, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="transcripts.zip"'
    }
  });
};
