/**
 * Tracks one terminal_execute call: watches session output for the start and
 * end markers, captures what the command printed between them, and — if the
 * call times out — keeps watching for the end marker so the session is known
 * to be busy until the command really finishes.
 */

import { AnsiStripper } from './ansi.js';
import { OutputCapture } from './output-capture.js';
import { endMarkerPattern, endMarkerPrefix, startMarker, type CommandInput } from './shell-wrapper.js';

export interface ExecIo {
  write(text: string): void;
  subscribe(listener: (text: string) => void): () => void;
  onClose(listener: () => void): () => void;
}

export type ExecStatus = 'completed' | 'timed_out' | 'interrupted' | 'session_closed';

export interface ExecResult {
  status: ExecStatus;
  stdout: string;
  exit_code: number | null;
  /** Whether the shell began running the command (start marker seen). */
  started: boolean;
  truncated: boolean;
  omitted_lines: number;
  duration_ms: number;
}

export const OUTPUT_HEAD_CHARS = 16_000;
export const OUTPUT_TAIL_CHARS = 48_000;
const PRE_START_KEEP = 8_000;
// Room for the exit code digits and the closing "__".
const END_MARKER_SLACK = 16;
// After Ctrl+C, how long to wait for the shell to still print the end marker.
const INTERRUPT_GRACE_MS = 1_500;

type Phase = 'pending' | 'prelude' | 'awaiting-start' | 'after-start' | 'output' | 'detached' | 'finished';

const ENTER = '\r';

export class CommandExecution {
  readonly startedAt = Date.now();
  private phase: Phase = 'pending';
  private readonly stripper = new AnsiStripper();
  private readonly startText: string;
  private readonly endPattern: RegExp;
  private readonly endKeep: number;
  private input: CommandInput = { preludes: [], final: '' };
  private preludeIndex = 0;
  private preStart = '';
  private startLine = '';
  private lookahead = '';
  private readonly capture = new OutputCapture(OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS);
  private started = false;
  private settle: ((result: ExecResult) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly io: ExecIo,
    readonly id: string,
    readonly command: string,
    private readonly onFinished: () => void,
  ) {
    this.startText = startMarker(id);
    this.endPattern = endMarkerPattern(id);
    this.endKeep = endMarkerPrefix(id).length + END_MARKER_SLACK;
  }

  /** True until the command has finished, been interrupted, or its session closed. */
  get active(): boolean {
    return this.phase !== 'finished';
  }

  /** True once the call has returned on timeout while the command keeps running. */
  get detached(): boolean {
    return this.phase === 'detached';
  }

  run(input: CommandInput, timeoutMs: number): Promise<ExecResult> {
    if (this.phase !== 'pending') throw new Error('CommandExecution.run called twice');
    this.input = input;
    return new Promise((resolve, reject) => {
      this.settle = resolve;
      this.cleanups.push(this.io.subscribe((text) => this.onData(text)));
      this.cleanups.push(this.io.onClose(() => this.dispose()));
      this.timer = setTimeout(() => this.conclude('timed_out'), timeoutMs);
      try {
        this.typeNextLine();
      } catch (err) {
        this.settle = null;
        this.finish();
        reject(err);
      }
    });
  }

  /** Types the next prelude line, or the final line once every prelude is acknowledged. */
  private typeNextLine(): void {
    const prelude = this.input.preludes[this.preludeIndex];
    if (prelude) {
      this.phase = 'prelude';
      this.io.write(prelude.line + ENTER);
    } else {
      this.phase = 'awaiting-start';
      this.io.write(this.input.final + ENTER);
    }
  }

  /** Called when Ctrl+C reaches the session. */
  interrupt(): void {
    if (this.phase === 'pending' || this.phase === 'finished') return;
    if (this.phase === 'detached') {
      this.finish();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.conclude('interrupted'), INTERRUPT_GRACE_MS);
  }

  /** Stops watching; a still-waiting caller gets a session_closed result. */
  dispose(): void {
    if (this.phase === 'finished') return;
    this.conclude('session_closed');
    this.finish();
  }

  private onData(raw: string): void {
    const text = this.stripper.push(raw);
    if (!text) return;
    switch (this.phase) {
      case 'prelude':
        this.scanForAck(text);
        break;
      case 'awaiting-start':
        this.scanForStart(text);
        break;
      case 'after-start':
        this.skipStartLine(text);
        break;
      case 'output':
        this.scanForEnd(text);
        break;
      case 'detached':
        this.watchForLateEnd(text);
        break;
    }
  }

  private scanForAck(text: string): void {
    const { ack } = this.input.preludes[this.preludeIndex];
    this.preStart += text;
    if (!this.preStart.includes(ack)) {
      if (this.preStart.length > PRE_START_KEEP * 2) this.preStart = this.preStart.slice(-PRE_START_KEEP);
      return;
    }
    this.preStart = '';
    this.preludeIndex++;
    try {
      this.typeNextLine();
    } catch {
      this.dispose();
    }
  }

  private scanForStart(text: string): void {
    this.preStart += text;
    const idx = this.preStart.indexOf(this.startText);
    if (idx === -1) {
      if (this.preStart.length > PRE_START_KEEP * 2) this.preStart = this.preStart.slice(-PRE_START_KEEP);
      return;
    }
    const rest = this.preStart.slice(idx + this.startText.length);
    this.preStart = '';
    this.started = true;
    this.phase = 'after-start';
    this.skipStartLine(rest);
  }

  // Waits until it's clear whether a line break follows the start marker.
  private skipStartLine(text: string): void {
    const pending = this.startLine + text;
    if (/^\r*$/.test(pending)) {
      this.startLine = pending;
      return;
    }
    this.startLine = '';
    this.phase = 'output';
    this.scanForEnd(pending.replace(/^\r*\n?/, ''));
  }

  private scanForEnd(text: string): void {
    this.lookahead += text;
    const match = this.endPattern.exec(this.lookahead);
    if (match) {
      this.capture.append(this.lookahead.slice(0, match.index));
      this.lookahead = '';
      this.conclude('completed', Number(match[1]));
      return;
    }
    const commit = this.lookahead.length - this.endKeep;
    if (commit > 0) {
      this.capture.append(this.lookahead.slice(0, commit));
      this.lookahead = this.lookahead.slice(commit);
    }
  }

  private watchForLateEnd(text: string): void {
    this.lookahead += text;
    if (this.endPattern.test(this.lookahead)) {
      this.finish();
      return;
    }
    this.lookahead = this.lookahead.slice(-this.endKeep);
  }

  private conclude(status: ExecStatus, exitCode: number | null = null): void {
    if (!this.settle) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    this.capture.append(this.lookahead);
    this.lookahead = '';
    const captured = this.capture.render();
    const result: ExecResult = {
      status,
      stdout: this.started ? captured.text.trimEnd() : '',
      exit_code: exitCode,
      started: this.started,
      truncated: captured.truncated,
      omitted_lines: captured.omittedLines,
      duration_ms: Date.now() - this.startedAt,
    };

    const settle = this.settle;
    this.settle = null;
    if (status === 'timed_out') this.phase = 'detached';
    else this.finish();
    settle(result);
  }

  private finish(): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.onFinished();
  }
}
