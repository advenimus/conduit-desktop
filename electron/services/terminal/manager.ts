/**
 * Unified terminal session manager for local shells and SSH sessions.
 *
 * Port of src-tauri/src/terminal_manager.rs
 *
 * Manages the lifecycle of all terminal sessions:
 *  - local PTY shells   (node-pty)
 *  - remote SSH shells   (ssh2)
 *
 * Each session buffers the last N lines of output so the MCP server
 * can call `readBuffer()` without a live event listener.
 *
 * Data is forwarded to the renderer via
 *   mainWindow.webContents.send('terminal:data', { sessionId, data: number[] })
 */

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

import { createLocalPty, parseShellType, type LocalPty, type ShellType, type PtyOptions } from './pty.js';
import { SshSession, type SshConfig } from '../ssh/client.js';

// ── Types ────────────────────────────────────────────────────────────

interface LineBuffer {
  lines: string[];
  currentLine: string;
}

interface LocalShellEntry {
  kind: 'local';
  pty: LocalPty;
  buffer: LineBuffer;
  started: boolean;
  preStartBuffer: Buffer[];
  _earlyDataDisposable: { dispose(): void } | null;
}

interface SshEntry {
  kind: 'ssh';
  session: SshSession;
  buffer: LineBuffer;
  started: boolean;
  preStartBuffer: Buffer[];
  _earlyDataHandler: ((data: Buffer) => void) | null;
  lastError: string | null;
}

type SessionEntry = LocalShellEntry | SshEntry;

const MAX_BUFFER_LINES = 10_000;
const DRAIN_AMOUNT = 1_000;

/** Matches CONDUIT sentinel markers in ANSI-stripped text. */
const CONDUIT_MARKER_RE = /__CONDUIT_(START_[a-f0-9]{6,}__|END_[a-f0-9]{6,}_EXIT_\d+__)/;

/** Strip ANSI SGR sequences for pattern matching. */
function stripAnsiForMatch(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Per-session state for the display filter. */
interface DisplayFilter {
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// ── TerminalManager ──────────────────────────────────────────────────

export class TerminalManager {
  private sessions = new Map<string, SessionEntry>();
  private displayFilters = new Map<string, DisplayFilter>();
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

    const entry: LocalShellEntry = {
      kind: 'local',
      pty,
      buffer: { lines: [], currentLine: '' },
      started: false,
      preStartBuffer: [],
      _earlyDataDisposable: null,
    };

    // Buffer data arriving before the renderer calls startReading()
    entry._earlyDataDisposable = pty.pty.onData((data: string) => {
      const bytes = Buffer.from(data, 'utf-8');
      entry.preStartBuffer.push(bytes);
      this.processData(entry.buffer, bytes);
    });

    this.sessions.set(id, entry);

    // Auto-print working directory so the user sees where they are.
    // Injected as synthetic output (not a PTY command) to avoid echo issues.
    if (cwd) {
      const cwdMsg = Buffer.from(`${cwd}\r\n`, 'utf-8');
      entry.preStartBuffer.push(cwdMsg);
      this.processData(entry.buffer, cwdMsg);
    }

    return id;
  }

  /**
   * Create a terminal running a specific command (e.g. `claude` or `codex` CLI).
   * Same lifecycle as createLocalShell but spawns a command instead of a shell.
   */
  createAgentTerminal(opts: { command: string; args?: string[]; cwd?: string }): string {
    const id = randomUUID();
    const pty = createLocalPty({ command: opts.command, args: opts.args, cwd: opts.cwd });

    const entry: LocalShellEntry = {
      kind: 'local',
      pty,
      buffer: { lines: [], currentLine: '' },
      started: false,
      preStartBuffer: [],
      _earlyDataDisposable: null,
    };

    // Buffer data arriving before the renderer calls startReading()
    entry._earlyDataDisposable = pty.pty.onData((data: string) => {
      const bytes = Buffer.from(data, 'utf-8');
      entry.preStartBuffer.push(bytes);
      this.processData(entry.buffer, bytes);
    });

    this.sessions.set(id, entry);
    return id;
  }

  // ── SSH session ──────────────────────────────────────────────────

  /** Create and connect an SSH session. Returns the session ID. */
  async createSshSession(config: SshConfig): Promise<string> {
    const id = randomUUID();
    const session = new SshSession(config);

    const entry: SshEntry = {
      kind: 'ssh',
      session,
      buffer: { lines: [], currentLine: '' },
      started: false,
      preStartBuffer: [],
      _earlyDataHandler: null,
      lastError: null,
    };

    // Log SSH errors and capture for disconnect reporting
    session.on('error', (err: Error) => {
      console.error(`[terminal] SSH session ${id} error:`, err.message);
      entry.lastError = err.message;
    });

    // Buffer data arriving before the renderer calls startReading().
    // Attached BEFORE connect() so MOTD/banner data is never lost.
    const earlyHandler = (data: Buffer) => {
      entry.preStartBuffer.push(data);
      this.processData(entry.buffer, data);
    };
    entry._earlyDataHandler = earlyHandler;
    session.on('data', earlyHandler);

    await session.connect();

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
      this.attachLocalReader(sessionId, entry);
    } else {
      this.attachSshReader(sessionId, entry);
    }
  }

  private attachLocalReader(id: string, entry: LocalShellEntry): void {
    // Remove early buffering handler before attaching permanent one (same tick — no gap)
    if (entry._earlyDataDisposable) {
      entry._earlyDataDisposable.dispose();
      entry._earlyDataDisposable = null;
    }

    entry.pty.pty.onData((data: string) => {
      const bytes = Buffer.from(data, 'utf-8');
      this.processData(entry.buffer, bytes);
      this.emitToRenderer(id, bytes);
    });

    entry.pty.pty.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      const win = this.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:status', {
          sessionId: id,
          status: 'disconnected',
          error: exitCode !== 0 ? `Process exited with code ${exitCode}` : null,
        });
      }
    });

    // Replay buffered pre-start data to the renderer
    for (const chunk of entry.preStartBuffer) {
      this.emitToRenderer(id, chunk);
    }
    entry.preStartBuffer.length = 0;
  }

  private attachSshReader(id: string, entry: SshEntry): void {
    // Remove early buffering handler before attaching permanent one (same tick — no gap)
    if (entry._earlyDataHandler) {
      entry.session.removeListener('data', entry._earlyDataHandler);
      entry._earlyDataHandler = null;
    }

    entry.session.on('data', (data: Buffer) => {
      this.processData(entry.buffer, data);
      this.emitToRenderer(id, data);
    });

    entry.session.on('close', () => {
      const errorMsg = entry.lastError;
      this.sessions.delete(id);
      const win = this.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:status', {
          sessionId: id,
          status: 'disconnected',
          error: errorMsg,
        });
      }
    });

    // Replay buffered pre-start data to the renderer
    for (const chunk of entry.preStartBuffer) {
      this.emitToRenderer(id, chunk);
    }
    entry.preStartBuffer.length = 0;
  }

  // ── Write / Resize / ReadBuffer / Close ──────────────────────────

  write(sessionId: string, data: Uint8Array): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session ${sessionId} not found`);

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
  }

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

  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return; // already gone

    if (entry.kind === 'local') {
      entry.pty.kill();
    } else {
      entry.session.close();
    }

    this.sessions.delete(sessionId);
    const filter = this.displayFilters.get(sessionId);
    if (filter?.timer) clearTimeout(filter.timer);
    this.displayFilters.delete(sessionId);
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

  /** Append data to a line buffer (matches Rust process_data logic). */
  private processData(buf: LineBuffer, data: Buffer): void {
    // Normalize \r\n to \n so carriage-return doesn't clear the line content
    const text = data.toString('utf-8').replace(/\r\n/g, '\n');
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

  /**
   * Send terminal data to the renderer, filtering out CONDUIT sentinel markers
   * so the user never sees __CONDUIT_START/END__ lines in the terminal.
   *
   * The backend LineBuffer (read by MCP via readBuffer) is NOT filtered,
   * so the MCP terminal_execute tool can still detect markers.
   */
  private emitToRenderer(sessionId: string, data: Buffer): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;

    let filter = this.displayFilters.get(sessionId);
    if (!filter) {
      filter = { pending: '', timer: null };
      this.displayFilters.set(sessionId, filter);
    }

    if (filter.timer) {
      clearTimeout(filter.timer);
      filter.timer = null;
    }

    const text = filter.pending + data.toString('utf-8');
    filter.pending = '';

    // Split into lines. All parts except the last are terminated by \n.
    const parts = text.split('\n');
    const output: string[] = [];

    for (let i = 0; i < parts.length - 1; i++) {
      const line = parts[i];
      const stripped = stripAnsiForMatch(line);
      // Skip lines that are or contain CONDUIT markers
      if (CONDUIT_MARKER_RE.test(stripped)) continue;
      output.push(line);
    }

    // Last part is a potentially incomplete line
    const tail = parts[parts.length - 1];
    if (tail) {
      const stripped = stripAnsiForMatch(tail);
      if (stripped.startsWith('__CONDUIT_')) {
        // Hold back — might be an incomplete marker line
        filter.pending = tail;
        filter.timer = setTimeout(() => {
          const f = this.displayFilters.get(sessionId);
          if (f && f.pending) {
            this.emitRaw(sessionId, Buffer.from(f.pending, 'utf-8'));
            f.pending = '';
          }
        }, 80);
      } else {
        output.push(tail);
      }
    }

    // Rejoin with \n (we split on \n so we restore the original newlines
    // between complete lines; the tail has no trailing \n)
    const hasCompleteLines = parts.length > 1;
    if (output.length === 0) return;
    const joined = output.slice(0, -1).join('\n')
      + (output.length > 1 ? '\n' : '')
      + output[output.length - 1]
      + (hasCompleteLines && output.length > 0 && parts[parts.length - 1] === '' ? '\n' : '');

    if (joined.length === 0) return;
    this.emitRaw(sessionId, Buffer.from(joined, 'utf-8'));
  }

  /** Send raw bytes to the renderer without filtering. */
  private emitRaw(sessionId: string, data: Buffer): void {
    const win = this.getMainWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('terminal:data', {
      sessionId,
      data: Array.from(data),
    });
  }

  /** Clean up all sessions (call on app quit). */
  dispose(): void {
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }
}
