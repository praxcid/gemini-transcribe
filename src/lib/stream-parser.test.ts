import { describe, it, expect } from 'vitest';
import { IncrementalTranscriptParser } from './stream-parser';

describe('IncrementalTranscriptParser', () => {
  it('parses complete JSON objects across chunk boundaries (cumulative)', () => {
    const parser = new IncrementalTranscriptParser();
    const chunk1 = '[{"timestamp":"00:00:01","speaker":"Speaker 1","text":"Hello"},';
    const chunk2 = '{"timestamp":"00:00:02","speaker":"Speaker 1","text":"world"}]';
    const first = parser.push(chunk1);
    const second = parser.push(chunk2);
    const all = [...first, ...second];
    expect(all.length).toBe(2);
    expect(all[0].text).toBe('Hello');
    expect(all[1].text).toBe('world');
  });

  it('continues parsing despite malformed fragments (cumulative)', () => {
    const parser = new IncrementalTranscriptParser();
    const part1 = parser.push('[{"timestamp":"00:00:01","speaker":"A","text":"Hi"},badjson');
    const part2 = parser.push(',{"timestamp":"00:00:02","speaker":"A","text":"there"}]');
    const combined = [...part1, ...part2];
    expect(combined.length).toBe(2);
    expect(combined[0].text).toBe('Hi');
    expect(combined[1].text).toBe('there');
  });
});
