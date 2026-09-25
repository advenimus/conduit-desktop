/**
 * Unified terminal session manager for local shells and SSH sessions.
 *
 * Port of src-tauri/src/terminal_manager.rs
 *
 * Manages the lifecycle of all terminal sessions:
 *  - local PTY shells   (node-pty)
 *  - remote SSH shells   (ssh2)
 *
 * Every chunk of output feeds three consumers:
 *  - a raw line buffer (legacy `readBuffer()` for older MCP clients),
 *  - the display filter → renderer + headless screen mirror,
 *  - live listeners (terminal_execute / terminal_send_keys captures).
 *
 * Data is forwarded to the renderer via
 *   mainWindow.webContents.send('terminal:data', { sessionId, data: number[] })
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import { createLocalPty, parseShellType, type LocalPty, type ShellType } from './pty.js';
import { SshSession, type SshConfig } from '../ssh/client.js';
import { AnsiStripper } from './ansi.js';
import { CommandExecution, type ExecIo, type ExecResult } from './command-execution.js';
import { DisplayFilter } from './display-filter.js';
import { TerminalError } from './errors.js';
import { OutputCapture } from './output-capture.js';
import { ScreenMirror, type ScreenSnapshot } from './screen-mirror.js';
import {
  detectShellKind,
  newMarkerId,
  planCommandInput,
  resolveShellFamily,
  type ShellKind,
  type ShellPreference,
} from './shell-wrapper.js';

// ── Types ────────────────────────────────────────────────────────────

interface LineBuffer {
  lines: string[];
  currentLine: string;
}

interface SessionState {
  buffer: LineBuffer;
  started: boolean;
  preStartDisplay: string[];
  display: DisplayFilter;
  mirror: ScreenMirror;
  listeners: Set<(text: string) => void>;
  closeListeners: Set<() => void>;
  createdAt: number;
  lastOutputAt: number;
  outputChars: number;
  shellKind: ShellKind;
  exec: CommandExecution | null;
  closed: boolean;
}

interface LocalShellEntry extends SessionState {
  kind: 'local';
  pty: LocalPty;
}

interface SshEntry extends SessionState {
  kind: 'ssh';
  session: SshSession;
  lastError: string | null;
}

type SessionEntry = LocalShellEntry | SshEntry;

export interface ExecuteRequest {
  command: string;
  timeoutMs: number;
  shell: ShellPreference;
}

export interface ExecuteResponse extends ExecResult {
  /** Visible screen when the shell never started the command, to show what it is doing instead. */
  screen?: string[];
}

export interface SendKeysResult {
  bytes_sent: number;
  output?: string;
  truncated?: boolean;
  screen?: string[];
}

const MAX_BUFFER_LINES = 10_000;
const DRAIN_AMOUNT = 1_000;

// A new session gets time to print its prompt before a command is typed.
const READY_YOUNG_SESSION_MS = 15_000;
const READY_QUIET_MS = 300;
const READY_MAX_WAIT_MS = 5_000;
const POLL_MS = 50;
const DEFAULT_IDLE_MS = 400;
const SEND_KEYS_OUTPUT_CHARS = 16_000;
const SCREEN_TAIL_LINES = 15;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandPreview(command: string): string {
  const firstLine = command.trim().split('\n')[0] ?? '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

// ── TerminalManager ──────────────────────────────────────────────────

export class TerminalManager {
  private sessions = new Map<string, SessionEntry>();
  private getMainWindow: () => BrowserWindow | null;

  /**
   * @param getMainWindow  Getter that returns the current BrowserWindow
   *                       (or null if none exists yet).
   */
  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  // ── Local shell ──────────────────────────────────────────────────

  /**
   * Create a local PTY shell. Returns the session ID.
   *
   * The PTY is spawned immediately but data is NOT forwarded to the
   * renderer until `startReading()` is called.  This mirrors the Rust
   * implementation's two-phase approach so the frontend can set up its
   * event listener before any data arrives.
   */
  createLocalShell(shellType?: string | null, cwd?: string | null): string {
    const id = randomUUID();
    const st: ShellType = parseShellType(shellType);
    const pty = createLocalPty({ shellType: st, cwd: cwd ?? undefined });
    const entry = this.attachLocal(id, pty, detectShellKind(pty.file));

    // Auto-print working directory so the user sees where they are.
    // Injected as synthetic output (not a PTY command) to avoid echo issues.
    if (cwd) this.ingest(entry, `${cwd}\r\n`, true);

    return id;
  }

  /**
   * Create a terminal running a specific command (e.g. `claude` or `codex` CLI).
   * Same lifecycle as createLocalShell but spawns a command instead of a shell.
   */
  createAgentTerminal(opts: { command: string; args?: string[]; cwd?: string }): string {
    const id = randomUUID();
    const pty = createLocalPty({ command: opts.command, args: opts.args, cwd: opts.cwd });
    this.attachLocal(id, pty, 'unknown');
    return id;
  }

  private attachLocal(id: string, pty: LocalPty, shellKind: ShellKind): LocalShellEntry {
    const entry: LocalShellEntry = {
      kind: 'local',
      pty,
      ...this.newState(shellKind),
      display: new DisplayFilter((text) => this.show(id, entry, text)),
    };
    pty.pty.onData((data: string) => this.ingest(entry, data));
    pty.pty.onExit(() => this.notifyClosed(entry));
    this.sessions.set(id, entry);
    return entry;
  }

  // ── SSH session ──────────────────────────────────────────────────

  /** Create and connect an SSH session. Returns the session ID. */
  async createSshSession(config: SshConfig): Promise<string> {
    const id = randomUUID();
    const session = new SshSession(config);
    const decoder = new StringDecoder('utf8');

    const entry: SshEntry = {
      kind: 'ssh',
      session,
      lastError: null,
      ...this.newState('posix'),
      display: new DisplayFilter((text) => this.show(id, entry, text)),
    };

    // Log SSH errors and capture for disconnect reporting
    session.on('error', (err: Error) => {
      console.error(`[terminal] SSH session ${id} error:`, err.message);
      entry.lastError = err.message;
    });

    // Attached BEFORE connect() so MOTD/banner data is never lost. The decoder
    // keeps multi-byte characters intact across chunk boundaries.
    session.on('data', (data: Buffer) => this.ingest(entry, decoder.write(data)));
    session.on('close', () => this.notifyClosed(entry));

    try {
      await session.connect();
    } catch (err) {
      this.disposeState(entry);
      throw err;
    }

    this.sessions.set(id, entry);
    return id;
  }

  // ── Start reading (two-phase start) ──────────────────────────────

  /**
   * Begin forwarding data from the underlying PTY/SSH channel to the
   * renderer.  Must be called by the frontend after it has set up its
   * `terminal:data` event listener.
   */
  startReading(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    if (entry.started) return; // idempotent
    entry.started = true;

    if (entry.kind === 'local') {
      entry.pty.pty.onExit(({ exitCode }) => {
        this.removeSession(sessionId, entry);
        this.sendStatus(sessionId, exitCode !== 0 ? `Process exited with code ${exitCode}` : null);
      });
    } else {
      entry.session.on('close', () => {
        this.removeSession(sessionId, entry);
        this.sendStatus(sessionId, entry.lastError);
      });
    }

    // Replay display output produced before the renderer was listening
    for (const chunk of entry.preStartDisplay) {
      this.emitRaw(sessionId, chunk);
    }
    entry.preStartDisplay.length = 0;
  }

  // ── Write / Resize / ReadBuffer / Close ──────────────────────────

  write(sessionId: string, data: Uint8Array): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

    // Ctrl+C from anyone (user or agent) may end a running terminal_execute command.
    if (data.includes(0x03)) entry.exec?.interrupt();

    if (entry.kind === 'local') {
      entry.pty.pty.write(Buffer.from(data).toString('utf-8'));
    } else {
      entry.session.write(data);
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

    if (entry.kind === 'local') {
      entry.pty.pty.resize(cols, rows);
    } else {
      entry.session.resize(cols, rows);
    }
    entry.mirror.resize(cols, rows);
  }

  /** Raw line buffer tail (unfiltered, with escape sequences). Kept for older MCP clients. */
  readBuffer(sessionId: string, lines: number): string {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

    const buf = entry.buffer;
    // Include currentLine so the latest partial line (e.g. prompt, marker) is visible
    const allLines = buf.currentLine
      ? [...buf.lines, buf.currentLine]
      : buf.lines;
    const start = Math.max(0, allLines.length - lines);
    return allLines.slice(start).join('\n');
  }

  /** Plain-text view of what the user's terminal currently shows. */
  readScreen(sessionId: string, lines: number): Promise<ScreenSnapshot> {
    return this.requireSession(sessionId).mirror.snapshot(lines);
  }

  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return; // already gone

    if (entry.kind === 'local') {
      entry.pty.kill();
    } else {
      entry.session.close();
    }
    this.removeSession(sessionId, entry);
  }

  // ── Agent command execution ──────────────────────────────────────

  /**
   * Run a command in the session's shell and wait for it to finish.
   * One command at a time per session; a timed-out command keeps the session
   * busy until it prints its end marker or is interrupted with Ctrl+C.
   */
  async execute(sessionId: string, request: ExecuteRequest): Promise<ExecuteResponse> {
    const entry = this.requireSession(sessionId);
    if (entry.exec?.active) throw this.busyError(entry.exec);
    const family = resolveShellFamily(request.shell, entry.shellKind);

    const id = newMarkerId();
    const execution: CommandExecution = new CommandExecution(this.execIo(entry), id, request.command, () => {
      if (entry.exec === execution) entry.exec = null;
      entry.display.endExec(id);
    });
    entry.exec = execution;

    try {
      const deadline = Date.now() + request.timeoutMs;
      await entry.mirror.flush();
      if (entry.mirror.alternateScreen) {
        throw new TerminalError(
          'SCREEN_BUSY',
          'A full-screen program (editor, pager, top, …) is open in this session. ' +
            'Read it with terminal_read_pane and exit it with terminal_send_keys before running commands.',
        );
      }
      await this.waitForShellReady(entry, deadline);

      const input = planCommandInput(family, request.command, id, entry.mirror.bracketedPasteMode);
      entry.display.beginExec(id, request.command);
      const result = await execution.run(input, Math.max(1_000, deadline - Date.now()));

      if (result.started || result.status === 'session_closed') return result;
      entry.display.endExec(id);
      const screen = await entry.mirror.snapshot(SCREEN_TAIL_LINES);
      return { ...result, screen: screen.lines };
    } catch (err) {
      if (entry.exec === execution) entry.exec = null;
      entry.display.endExec(id);
      throw err;
    }
  }

  /**
   * Send raw input. With `waitMs > 0`, also wait for the output to settle and
   * return what the session printed in response.
   */
  async sendKeys(
    sessionId: string,
    data: Uint8Array,
    opts: { waitMs: number; idleMs?: number },
  ): Promise<SendKeysResult> {
    const entry = this.requireSession(sessionId);
    if (opts.waitMs <= 0) {
      this.write(sessionId, data);
      return { bytes_sent: data.length };
    }

    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    const stripper = new AnsiStripper();
    const capture = new OutputCapture(0, SEND_KEYS_OUTPUT_CHARS);
    let lastOutputAt = 0;
    let closed = false;
    const unsubscribe = this.execIo(entry).subscribe((text) => {
      const plain = stripper.push(text);
      if (!plain) return;
      capture.append(plain);
      lastOutputAt = Date.now();
    });
    const onClose = () => { closed = true; };
    entry.closeListeners.add(onClose);

    try {
      this.write(sessionId, data);
      const deadline = Date.now() + opts.waitMs;
      while (!closed && Date.now() < deadline) {
        if (lastOutputAt > 0 && Date.now() - lastOutputAt >= idleMs) break;
        await delay(POLL_MS);
      }
    } finally {
      unsubscribe();
      entry.closeListeners.delete(onClose);
    }

    const captured = capture.render();
    const result: SendKeysResult = {
      bytes_sent: data.length,
      output: captured.text.replace(/^\n/, '').trimEnd(),
      truncated: captured.truncated,
    };
    if (!closed) {
      const screen = await entry.mirror.snapshot(SCREEN_TAIL_LINES);
      if (screen.alternateScreen) result.screen = screen.lines;
    }
    return result;
  }

  // ── Query helpers ────────────────────────────────────────────────

  isConnected(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;

    if (entry.kind === 'local') {
      // node-pty doesn't expose a direct "alive" check; the session
      // is removed on exit via onExit handler, so presence = connected.
      return true;
    }
    return entry.session.connected;
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private newState(shellKind: ShellKind): Omit<SessionState, 'display'> {
    const now = Date.now();
    return {
      buffer: { lines: [], currentLine: '' },
      started: false,
      preStartDisplay: [],
      mirror: new ScreenMirror(),
      listeners: new Set(),
      closeListeners: new Set(),
      createdAt: now,
      lastOutputAt: now,
      outputChars: 0,
      shellKind,
      exec: null,
      closed: false,
    };
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new TerminalError(
        'SESSION_NOT_FOUND',
        `Session ${sessionId} not found. It may have been closed; call connection_list for current session ids.`,
      );
    }
    return entry;
  }

  private execIo(entry: SessionEntry): ExecIo {
    return {
      write: (text) => {
        if (entry.kind === 'local') entry.pty.pty.write(text);
        else entry.session.write(Buffer.from(text, 'utf-8'));
      },
      subscribe: (listener) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      onClose: (listener) => {
        entry.closeListeners.add(listener);
        return () => entry.closeListeners.delete(listener);
      },
    };
  }

  private busyError(exec: CommandExecution): TerminalError {
    const seconds = Math.round((Date.now() - exec.startedAt) / 1000);
    const preview = commandPreview(exec.command);
    if (exec.detached) {
      return new TerminalError(
        'SESSION_BUSY',
        `The previous command (\`${preview}\`) timed out and is still running (started ${seconds}s ago). ` +
          'Check it with terminal_read_pane, answer any prompt with terminal_send_keys, ' +
          'or interrupt it by sending "\\x03" with terminal_send_keys.',
      );
    }
    return new TerminalError(
      'SESSION_BUSY',
      `Another terminal_execute call (\`${preview}\`) is still running in this session ` +
        `(started ${seconds}s ago). Wait for it to return before running the next command.`,
    );
  }

  private async waitForShellReady(entry: SessionEntry, deadline: number): Promise<void> {
    const limit = Math.min(deadline, Date.now() + READY_MAX_WAIT_MS);
    while (Date.now() < limit) {
      const young = Date.now() - entry.createdAt < READY_YOUNG_SESSION_MS;
      const quiet = Date.now() - entry.lastOutputAt >= READY_QUIET_MS;
      if (entry.outputChars > 0 && (!young || quiet)) return;
      await delay(POLL_MS);
    }
  }

  private ingest(entry: SessionEntry, text: string, synthetic = false): void {
    if (!text || entry.closed) return;
    this.processData(entry.buffer, text);
    if (!synthetic) {
      entry.lastOutputAt = Date.now();
      entry.outputChars += text.length;
    }
    // Display first, so the filter has consumed an end marker before an
    // execution that saw it finishes and resets the filter.
    entry.display.push(text);
    for (const listener of entry.listeners) listener(text);
  }

  private show(sessionId: string, entry: SessionEntry, text: string): void {
    entry.mirror.write(text);
    if (entry.started) this.emitRaw(sessionId, text);
    else entry.preStartDisplay.push(text);
  }

  private notifyClosed(entry: SessionEntry): void {
    for (const listener of [...entry.closeListeners]) listener();
  }

  private removeSession(sessionId: string, entry: SessionEntry): void {
    if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
    this.disposeState(entry);
  }

  private disposeState(entry: SessionEntry): void {
    entry.closed = true;
    this.notifyClosed(entry);
    entry.exec?.dispose();
    entry.display.dispose();
    entry.mirror.dispose();
  }

  private sendStatus(sessionId: string, error: string | null): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:status', {
        sessionId,
        status: 'disconnected',
        error,
      });
    }
  }

  /** Append data to a line buffer (matches Rust process_data logic). */
  private processData(buf: LineBuffer, data: string): void {
    // Normalize \r\n to \n so carriage-return doesn't clear the line content
    const text = data.replace(/\r\n/g, '\n');
    for (const ch of text) {
      if (ch === '\n') {
        buf.lines.push(buf.currentLine);
        buf.currentLine = '';
        if (buf.lines.length > MAX_BUFFER_LINES) {
          buf.lines.splice(0, DRAIN_AMOUNT);
        }
      } else if (ch === '\r') {
        // Standalone \r (not \r\n) — carriage return overwrites from line start
        buf.currentLine = '';
      } else {
        buf.currentLine += ch;
      }
    }
  }

  /** Send display text to the renderer. */
  private emitRaw(sessionId: string, text: string): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('terminal:data', {
      sessionId,
      data: Array.from(Buffer.from(text, 'utf-8')),
    });
  }

  /** Clean up all sessions (call on app quit). */
  dispose(): void {
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }
}
