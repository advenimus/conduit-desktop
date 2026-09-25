/**
 * Text helpers for the terminal tools: key-escape parsing and escape-sequence
 * stripping for output read from older Conduit apps.
 */

// CSI (7-bit and 8-bit), OSC, DCS/SOS/PM/APC strings, and other ESC sequences
// (whose final byte can't be one of the introducers [ ] P X ^ _).
const ESCAPE_SEQUENCE_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-OQ-WYZ\\`-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ESCAPE_SEQUENCE_RE, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

const SIMPLE_ESCAPES: Record<string, number> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  e: 0x1b,
  '\\': 0x5c,
};

/**
 * Parse key escape sequences: \xHH (byte), \n, \r, \t, \e (Escape), \\.
 * Anything else after a backslash is sent literally.
 * Port of crates/conduit-mcp/src/tools/mod.rs::parse_key_sequences
 */
export function parseKeySequences(input: string): Buffer {
  const result: number[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      const next = input[i + 1];
      const hex = input.slice(i + 2, i + 4);
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
        result.push(parseInt(hex, 16));
        i += 4;
        continue;
      }
      if (next in SIMPLE_ESCAPES) {
        result.push(SIMPLE_ESCAPES[next]);
        i += 2;
        continue;
      }
      result.push(0x5c);
      i += 1;
      continue;
    }
    // Regular character (may be a surrogate pair) - encode as UTF-8
    const codePoint = input.codePointAt(i)!;
    const ch = String.fromCodePoint(codePoint);
    for (const b of Buffer.from(ch, 'utf-8')) result.push(b);
    i += ch.length;
  }

  return Buffer.from(result);
}
