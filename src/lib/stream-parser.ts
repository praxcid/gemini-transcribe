export interface TranscriptChunk { timestamp: string; speaker: string; text: string }

// Incremental parser for a streaming JSON array of transcript objects.
// Feed raw text chunks (as they arrive), get back newly parsed entries.
export class IncrementalTranscriptParser {
  private started = false;
  private inString = false;
  private escape = false;
  private depth = 0; // depth within current object
  private current = '';
  private carry = '';

  push(chunk: string): TranscriptChunk[] {
    this.carry += chunk;
    return this.consume();
  }

  private consume(): TranscriptChunk[] {
    const out: TranscriptChunk[] = [];
    let i = 0;
    while (i < this.carry.length) {
      const ch = this.carry[i];
      if (!this.started) {
        if (ch === '[') this.started = true;
        i++;
        continue;
      }
      this.current += ch;
      if (this.inString) {
        if (this.escape) this.escape = false; else if (ch === '\\') this.escape = true; else if (ch === '"') this.inString = false;
      } else {
        if (ch === '"') this.inString = true;
        else if (ch === '{') this.depth++;
        else if (ch === '}') this.depth--;
        if (this.depth === 0 && ch === '}') {
          let candidate = this.current.trim();
          if (candidate.endsWith(',')) candidate = candidate.slice(0, -1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed.timestamp === 'string' && typeof parsed.speaker === 'string' && typeof parsed.text === 'string') {
              out.push(parsed);
              this.current = '';
            }
          } catch {
            // keep accumulating
          }
        }
        if (ch === ']') {
          break; // end of array
        }
      }
      i++;
    }
    this.carry = this.current; // retain partial object fragment
    return out;
  }
}

export function parseChunkStream(chunks: string[]): TranscriptChunk[] {
  const parser = new IncrementalTranscriptParser();
  let all: TranscriptChunk[] = [];
  for (const c of chunks) all = all.concat(parser.push(c));
  return all;
}
