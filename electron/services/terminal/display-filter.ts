/**
 * Decides what terminal output the user sees.
 *
 * - Always hides stray marker lines, including the `echo '__CONDUIT_START_…'`
 *   wrappers typed by older MCP clients.
 * - While terminal_execute runs a command in a POSIX shell, hides the encoded
 *   wrapper the shell echoes, shows the agent's real command in its place, and
 *   removes the end marker, so it reads as if the command was typed by hand.
 */

import { sanitizeForDisplay, stripAnsi } from './ansi.js';
import { endMarkerPattern, endMarkerPrefix, MARKER_PREFIX, startMarker } from './shell-wrapper.js';

const MARKER_LINE_RE = /__CONDUIT_(START_[a-f0-9]{6,}__|END_[a-f0-9]{6,}_EXIT_\d+__|ACK_[a-f0-9]{6,}_\d+__)/;
// Kept from hidden echo output: DEC private modes (bracketed paste, cursor keys,
// alt screen), keypad mode, and OSC (title, cwd) so terminal state stays in sync.
const PRESERVED_SEQUENCE_RE = /\x1b\[\?[\d;]*[hl]|\x1b[=>]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Queries a line editor may block on (cursor position, device attributes, mode reports).
const QUERY_SEQUENCE_RE = /\x1b\[[?>=]?[\d;]*[nc]|\x1b\[\?[\d;]*\$p|\x1b\[>[\d;]*q/g;
const TRAILING_CSI_RE = /\r?\n((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/;

const TAIL_FLUSH_MS = 80;
const ECHO_IDLE_MS = 3_000;
const ECHO_MAX_MS = 60_000;
const ECHO_MAX_CHARS = 2_000_000;
const ECHO_MAX_LINES = 30;
const ECHO_MAX_LINE_CHARS = 2_000;

type Mode =
  | { kind: 'pass' }
  | { kind: 'echo'; id: string; command: string; since: number }
  | { kind: 'output'; id: string; endPattern: RegExp; endPrefix: string };

function lastLineSegment(text: string): string {
  return text.slice(text.lastIndexOf('\r') + 1);
}

function couldBeMarkerLine(text: string): boolean {
  const s = lastLineSegment(stripAnsi(text));
  return s.startsWith(MARKER_PREFIX) || (s.length > 0 && MARKER_PREFIX.startsWith(s));
}

function isEndMarkerPrefix(text: string, prefix: string): boolean {
  if (text === '' || prefix.startsWith(text)) return true;
  return text.startsWith(prefix) && /^\d*_?$/.test(text.slice(prefix.length));
}

/** Where to start holding output back because it may be the beginning of the end marker. */
function endHoldStart(text: string, prefix: string): number {
  const nl = text.lastIndexOf('\n');
  if (!isEndMarkerPrefix(text.slice(nl + 1), prefix)) return text.length;
  if (nl === -1) return 0;
  return nl > 0 && text[nl - 1] === '\r' ? nl - 1 : nl;
}

export function formatCommandEcho(command: string): string {
  const lines = sanitizeForDisplay(command).replace(/\n+$/, '').split('\n')
    .map((line) => (line.length > ECHO_MAX_LINE_CHARS ? `${line.slice(0, ECHO_MAX_LINE_CHARS)}…` : line));
  const shown = lines.length > ECHO_MAX_LINES
    ? [...lines.slice(0, ECHO_MAX_LINES), `… (${lines.length - ECHO_MAX_LINES} more lines)`]
    : lines;
  return `${shown.join('\r\n')}\r\n`;
}

export class DisplayFilter {
  private mode: Mode = { kind: 'pass' };
  private held = '';
  private skipLineBreak = false;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private echoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly emit: (text: string) => void) {}

  beginExec(id: string, command: string): void {
    this.releaseHeld();
    this.mode = { kind: 'echo', id, command, since: Date.now() };
    this.armEchoTimer();
  }

  /** The shell never started the command: show what was held back and stop hiding. */
  abortExec(id: string): void {
    if (this.mode.kind !== 'echo' || this.mode.id !== id) return;
    this.clearEchoTimer();
    const held = this.held;
    this.held = '';
    this.mode = { kind: 'pass' };
    if (held) this.pushPass(held);
  }

  /** The command is over without a normal end marker (interrupted, session closed). */
  endExec(id: string): void {
    if (this.mode.kind === 'echo' && this.mode.id === id) {
      this.abortExec(id);
    } else if (this.mode.kind === 'output' && this.mode.id === id) {
      this.mode = { kind: 'pass' };
      this.releaseHeld();
    }
  }

  push(text: string): void {
    if (!text) return;
    switch (this.mode.kind) {
      case 'echo':
        this.pushEcho(text);
        break;
      case 'output':
        this.pushOutput(text);
        break;
      default:
        this.pushPass(text);
    }
  }

  dispose(): void {
    this.clearTailTimer();
    this.clearEchoTimer();
  }

  private pushPass(text: string): void {
    let all = this.held + text;
    this.held = '';
    this.clearTailTimer();
    if (this.skipLineBreak) {
      this.skipLineBreak = false;
      all = all.replace(/^\r?\n/, '');
    }

    const lines = all.split('\n');
    const tail = lines.pop() ?? '';
    let out = '';
    for (const line of lines) {
      if (!MARKER_LINE_RE.test(stripAnsi(line))) out += `${line}\n`;
    }
    if (tail && couldBeMarkerLine(tail)) {
      this.held = tail;
      this.armTailTimer();
    } else {
      out += tail;
    }
    if (out) this.emit(out);
  }

  private pushEcho(text: string): void {
    if (this.mode.kind !== 'echo') return;
    const queries = text.match(QUERY_SEQUENCE_RE);
    if (queries) this.emit(queries.join(''));
    this.held += text.replace(QUERY_SEQUENCE_RE, '');

    const { id, command } = this.mode;
    const start = startMarker(id);
    const idx = this.held.indexOf(start);
    if (idx === -1) {
      if (this.held.length > ECHO_MAX_CHARS) this.abortExec(id);
      else this.armEchoTimer();
      return;
    }
    const after = this.held.slice(idx + start.length);
    if (/^\r*$/.test(after)) return;

    const preserved = this.held.slice(0, idx).match(PRESERVED_SEQUENCE_RE)?.join('') ?? '';
    this.held = '';
    this.clearEchoTimer();
    this.mode = { kind: 'output', id, endPattern: endMarkerPattern(id), endPrefix: endMarkerPrefix(id) };
    this.emit(preserved + formatCommandEcho(command));
    this.pushOutput(after.replace(/^\r*\n?/, ''));
  }

  private pushOutput(text: string): void {
    if (this.mode.kind !== 'output') {
      this.pushPass(text);
      return;
    }
    const all = this.held + text;
    this.held = '';
    this.clearTailTimer();

    const match = this.mode.endPattern.exec(all);
    if (match) {
      const before = all.slice(0, match.index).replace(TRAILING_CSI_RE, '$1');
      const after = all.slice(match.index + match[0].length);
      this.mode = { kind: 'pass' };
      if (before) this.emit(before);
      if (/^\r?$/.test(after)) {
        this.skipLineBreak = true;
        return;
      }
      this.pushPass(after.replace(/^\r?\n/, ''));
      return;
    }

    const holdFrom = endHoldStart(all, this.mode.endPrefix);
    if (holdFrom > 0) this.emit(all.slice(0, holdFrom));
    this.held = all.slice(holdFrom);
    if (this.held) this.armTailTimer();
  }

  private releaseHeld(): void {
    this.clearTailTimer();
    const held = this.held;
    this.held = '';
    if (held) this.emit(held);
  }

  private armTailTimer(): void {
    this.clearTailTimer();
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      this.releaseHeld();
    }, TAIL_FLUSH_MS);
  }

  private clearTailTimer(): void {
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
  }

  // Echo is held while it keeps arriving (slow line editors), up to a hard cap.
  private armEchoTimer(): void {
    if (this.mode.kind !== 'echo') return;
    const { id, since } = this.mode;
    this.clearEchoTimer();
    const remaining = ECHO_MAX_MS - (Date.now() - since);
    this.echoTimer = setTimeout(() => this.abortExec(id), Math.max(0, Math.min(ECHO_IDLE_MS, remaining)));
  }

  private clearEchoTimer(): void {
    if (this.echoTimer) clearTimeout(this.echoTimer);
    this.echoTimer = null;
  }
}
