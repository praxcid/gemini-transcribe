// Dynamically import ffmpeg to handle environments where named exports differ.
type CreateFfmpegFn = (opts?: any) => any;
let createFfmpeg: CreateFfmpegFn | null = null;
let ffmpegInstance: any = null;
let ffmpegLoading: Promise<void> | null = null;

const SUPPORTED_AUDIO_MIME_PREFIXES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/ogg'
];

export function isLikelyUnsupported(mime: string) {
  if (!mime.startsWith('audio/')) return false; // Only care about audio
  return !SUPPORTED_AUDIO_MIME_PREFIXES.some((p) => mime === p);
}

async function loadFFmpeg() {
  if (ffmpegInstance && ffmpegInstance.isLoaded?.()) return;
  if (!createFfmpeg) {
    const mod: any = await import('@ffmpeg/ffmpeg');
    // Try common export patterns
    createFfmpeg = (mod.createFFmpeg || mod.default?.createFFmpeg || mod.default || mod) as CreateFfmpegFn;
  }
  if (!ffmpegInstance) {
    ffmpegInstance = createFfmpeg!({ log: false });
  }
  if (!ffmpegInstance.isLoaded?.()) {
    if (!ffmpegLoading) {
      ffmpegLoading = ffmpegInstance.load();
    }
    await ffmpegLoading;
  }
}

export interface ConversionResult {
  file: File;
  converted: boolean;
  original: File;
  error?: string;
}

export async function ensureMp3(
  file: File,
  onProgress?: (ratio: number) => void,
  options?: { retries?: number }
): Promise<ConversionResult> {
  if (!isLikelyUnsupported(file.type)) {
    return { file, converted: false, original: file };
  }
  const maxRetries = options?.retries ?? 2;
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      await loadFFmpeg();
      const ffmpeg = ffmpegInstance!;
      if (ffmpeg.setProgress && onProgress) {
        ffmpeg.setProgress(({ ratio }: { ratio: number }) => {
          if (typeof ratio === 'number' && isFinite(ratio)) onProgress(Math.min(1, Math.max(0, ratio)));
        });
      }
      const inputName = 'input';
      const ext = file.name.split('.').pop() || 'dat';
      const inFile = `${inputName}.${ext}`;
      const outFile = 'output.mp3';
      const arrayBuffer = await file.arrayBuffer();
      ffmpeg.FS('writeFile', inFile, new Uint8Array(arrayBuffer));
      await ffmpeg.run('-i', inFile, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', outFile);
      const data = ffmpeg.FS('readFile', outFile);
      const mp3Blob = new Blob([data.buffer], { type: 'audio/mpeg' });
      const mp3File = new File([mp3Blob], file.name.replace(/\.[^.]+$/, '') + '.mp3', { type: 'audio/mpeg' });
      return { file: mp3File, converted: true, original: file };
    } catch (e: any) {
      if (attempt === maxRetries) {
        return { file, converted: false, original: file, error: e?.message || String(e) };
      }
      attempt++;
    }
  }
  return { file, converted: false, original: file, error: 'Unknown conversion failure' };
}

export async function batchEnsureMp3(
  files: File[],
  onFile?: (res: ConversionResult, index: number) => void,
  onProgressPerFile?: (index: number, ratio: number) => void,
  isAborted?: () => boolean
) {
  const results: ConversionResult[] = [];
  for (let i = 0; i < files.length; i++) {
    if (isAborted?.()) break;
    const result = await ensureMp3(files[i], (r) => onProgressPerFile?.(i, r));
    results.push(result);
    onFile?.(result, i);
    if (isAborted?.()) break;
  }
  return results;
}
