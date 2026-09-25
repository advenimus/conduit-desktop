// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { OutputCapture } from '../output-capture.js';

describe('OutputCapture', () => {
  it('returns everything as plain text when under the limits', () => {
    const c = new OutputCapture(100, 100);
    c.append('one\r\n');
    c.append('\x1b[32mtwo\x1b[0m\r\n');
    expect(c.render()).toEqual({ text: 'one\ntwo\n', truncated: false, omittedLines: 0 });
  });

  it('keeps the head and tail on whole lines and counts omitted lines', () => {
    const c = new OutputCapture(20, 30);
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    for (const line of lines) c.append(`${line}\r\n`);

    const out = c.render();
    expect(out.truncated).toBe(true);
    const shown = out.text.split('\n');
    expect(shown[0]).toBe('line 1');
    expect(shown).toContain('line 1000');
    const note = shown.find((l) => l.startsWith('[... '))!;
    const omitted = Number(/\[\.\.\. (\d+) lines omitted/.exec(note)![1]);
    const kept = shown.filter((l) => l.startsWith('line ')).length;
    expect(kept + omitted).toBe(1000);
    expect(out.omittedLines).toBe(omitted);
  });

  it('bounds memory while appending huge output', () => {
    const c = new OutputCapture(10, 50);
    for (let i = 0; i < 10_000; i++) c.append('0123456789\n');
    const { text } = c.render();
    expect(text.length).toBeLessThan(200);
  });
});
