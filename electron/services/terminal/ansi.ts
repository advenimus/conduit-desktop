/**
 * Turns raw terminal output (VT escape sequences, carriage returns,
 * backspaces) into plain text an AI agent can read.
 */

// CSI (7-bit and 8-bit), OSC, DCS/SOS/PM/APC strings, and other ESC sequences
// (whose final byte can't be one of the introducers [ ] P X ^ _).
const ESCAPE_SEQUENCE_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-OQ-WYZ\\`-~]/g;

// A sequence that has started but not yet finished at the end of a chunk.
const INCOMPLETE_SEQUENCE_RE =
  /^(?:\x1b(?:\[[0-?]*[ -/]*|\][^\x07]*|[PX^_][\s\S]*|[ -/]*)|\x9b[0-?]*[ -/]*)$/;

// Past this length an "incomplete" sequence is treated as garbage, not carried.
const MAX_CARRY = 4096;

// C0 controls except \t and \n, DEL, and C1 controls (incl. stray ESC left by malformed input).
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

function findIncompleteStart(text: string): number {
  for (let i = text.search(/[\x1b\x9b]/); i !== -1 && i < text.length; i++) {
    const ch = text[i];
    if (ch !== '\x1b' && ch !== '\x9b') continue;
    if (text.length - i > MAX_CARRY) continue;
    if (INCOMPLETE_SEQUENCE_RE.test(text.slice(i))) return i;
  }
  return -1;
}

/** Strips escape sequences from a stream, carrying partial sequences across chunks. */
export class AnsiStripper {
  private carry = '';

  push(chunk: string): string {
    const text = (this.carry + chunk).replace(ESCAPE_SEQUENCE_RE, '');
    this.carry = '';
    const cut = findIncompleteStart(text);
    if (cut === -1) return text;
    this.carry = text.slice(cut);
    return text.slice(0, cut);
  }
}

export function stripAnsi(text: string): string {
  const stripped = text.replace(ESCAPE_SEQUENCE_RE, '');
  const cut = findIncompleteStart(stripped);
  return cut === -1 ? stripped : stripped.slice(0, cut);
}

/** Resolves `\r` overwrites (last non-blank segment wins) and backspaces within one line. */
function renderLine(line: string): string {
  let text = line;
  if (text.includes('\r')) {
    const segments = text.split('\r');
    text = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].trim() !== '') {
        text = segments[i];
        break;
      }
    }
  }
  if (text.includes('\b')) {
    const out: string[] = [];
    for (const ch of text) {
      if (ch === '\b') out.pop();
      else out.push(ch);
    }
    text = out.join('');
  }
  return text.replace(CONTROL_CHARS_RE, '');
}

export function toPlainText(text: string): string {
  return stripAnsi(text)
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map(renderLine)
    .join('\n');
}

/** Removes control characters so user-supplied text can be echoed to a terminal safely. */
export function sanitizeForDisplay(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS_RE, '');
}
