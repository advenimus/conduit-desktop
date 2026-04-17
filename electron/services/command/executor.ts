/**
 * Command executor service.
 *
 * Runs commands as a different OS user using:
 *  - macOS/Linux: `su - <user> -c '<command>'` via node-pty
 *  - Windows: CreateProcessWithLogonW via koffi FFI (no admin required)
 *  - Current user mode: child_process.spawn (no elevation)
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import * as nodePty from 'node-pty';

// Lazy-loaded on Windows only
let win32: typeof import('./win32.js') | null = null;
async function getWin32() {
  if (!win32) win32 = await import('./win32.js');
  return win32;
}

// ---------- Types ----------

export interface CommandConfig {
  command: string;
  args?: string;
  workingDir?: string;
  shell?: string;
  timeout?: number;
  runAsMode: 'credential' | 'current';
  guiApp?: boolean;
}

export interface CommandCredential {
  username: string;
  password: string;
  domain?: string;
}

export type CommandStatus = 'running' | 'exited' | 'error' | 'timeout';

export interface CommandResult {
  output: string;
  isRunning: boolean;
  exitCode: number | null;
  status: CommandStatus;
  error?: string;
}

// ---------- CommandSession ----------

export class CommandSession extends EventEmitter {
  readonly id: string;
  private outputBuffer: string[] = [];
  private maxBufferBytes = 10 * 1024 * 1024; // 10MB
  private currentBufferBytes = 0;
  private ptyProcess: nodePty.IPty | null = null;
  private childProcess: ChildProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _exitCode: number | null = null;
  private _status: CommandStatus = 'running';
  private _error: string | null = null;
  private passwordSent = false;
  /** Win32 process handle for per-session cancel support */
  private win32ProcessHandle: unknown | null = null;

  constructor(id: string) {
    super();
    this.id = id;
  }

  get status(): CommandStatus {
    return this._status;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get isRunning(): boolean {
    return this._status === 'running';
  }

  getOutput(): string {
    return this.outputBuffer.join('');
  }

  getResult(): CommandResult {
    return {
      output: this.getOutput(),
      isRunning: this.isRunning,
      exitCode: this._exitCode,
      status: this._status,
      error: this._error ?? undefined,
    };
  }

  /**
   * Execute a command as the current user (no elevation).
   */
  executeAsCurrent(config: CommandConfig): void {
    const fullCommand = config.args
      ? `${config.command} ${config.args}`
      : config.command;

    const shell = config.shell || (os.platform() === 'win32' ? 'cmd' : '/bin/sh');
    const shellArgs = os.platform() === 'win32'
      ? ['/c', fullCommand]
      : ['-c', fullCommand];

    const cwd = config.workingDir || os.homedir();

    if (config.guiApp) {
      this.executeGuiAsCurrent(config);
      return;
    }

    try {
      const child = spawn(shell, shellArgs, {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.childProcess = child;

      child.stdout?.on('data', (data: Buffer) => {
        this.appendOutput(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        this.appendOutput(data.toString());
      });

      child.on('error', (err) => {
        this._status = 'error';
        this._error = err.message;
        this.emit('error', err.message);
      });

      child.on('close', (code) => {
        this.clearTimeout();
        this._exitCode = code;
        this._status = 'exited';
        this.emit('exit', code);
      });

      this.setupTimeout(config.timeout);
    } catch (err) {
      this._status = 'error';
      this._error = err instanceof Error ? err.message : String(err);
      this.emit('error', this._error);
    }
  }

  /**
   * Execute a GUI app as the current user.
   */
  private executeGuiAsCurrent(config: CommandConfig): void {
    const args = config.args ? config.args.split(/\s+/) : [];
    const cwd = config.workingDir || os.homedir();

    try {
      let command: string;
      let spawnArgs: string[];

      if (os.platform() === 'darwin') {
        // macOS: use open -a for GUI apps
        command = 'open';
        spawnArgs = ['-a', config.command, ...args];
      } else {
        command = config.command;
        spawnArgs = args;
      }

      const child = spawn(command, spawnArgs, {
        cwd,
        detached: true,
        stdio: 'ignore',
      });

      child.unref();
      this._exitCode = 0;
      this._status = 'exited';
      this.appendOutput(`Launched: ${config.command} ${config.args ?? ''}\n`);
      this.emit('exit', 0);
    } catch (err) {
      this._status = 'error';
      this._error = err instanceof Error ? err.message : String(err);
      this.emit('error', this._error);
    }
  }

  /**
   * Execute a command as a different user via `su` + node-pty.
   */
  executeAsUser(config: CommandConfig, credential: CommandCredential): void {
    if (os.platform() === 'win32') {
      this.executeAsUserWindows(config, credential);
      return;
    }

    if (config.guiApp) {
      this.executeGuiAsUser(config, credential);
      return;
    }

    const fullCommand = this.buildFullCommand(config);

    try {
      const pty = nodePty.spawn('su', ['-', credential.username, '-c', fullCommand], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: config.workingDir || os.homedir(),
        env: process.env as Record<string, string>,
      });

      this.ptyProcess = pty;

      pty.onData((data: string) => {
        // Watch for password prompt and send password
        if (!this.passwordSent && this.isPasswordPrompt(data)) {
          this.passwordSent = true;
          pty.write(credential.password + '\r');
          return; // Don't forward the prompt
        }

        // Filter out the password echo line (if any)
        if (this.passwordSent && !this.hasReceivedOutput()) {
          // Skip empty lines right after password
          const trimmed = data.trim();
          if (trimmed === '' || trimmed === 'Password:') return;
        }

        this.appendOutput(data);
      });

      pty.onExit(({ exitCode }) => {
        this.clearTimeout();
        this._exitCode = exitCode;
        this._status = 'exited';
        this.emit('exit', exitCode);
      });

      this.setupTimeout(config.timeout);
    } catch (err) {
      this._status = 'error';
      this._error = err instanceof Error ? err.message : String(err);
      this.emit('error', this._error);
    }
  }

  /**
   * Execute a GUI app as a different user.
   */
  private executeGuiAsUser(config: CommandConfig, credential: CommandCredential): void {
    const platform = os.platform();

    if (platform === 'darwin') {
      // macOS: su - user -c 'open -a "AppName" --args ...'
      const appCmd = config.args
        ? `open -a "${config.command}" --args ${config.args}`
        : `open -a "${config.command}"`;
      this.executeAsUser({ ...config, command: appCmd, args: '', guiApp: false }, credential);
    } else if (platform === 'linux') {
      // Linux/X11: grant display access, then launch
      const display = process.env.DISPLAY || ':0';
      const xhostCmd = `xhost +SI:localuser:${credential.username} 2>/dev/null; `;
      const appCmd = config.args
        ? `DISPLAY=${display} ${config.command} ${config.args}`
        : `DISPLAY=${display} ${config.command}`;
      this.executeAsUser({ ...config, command: xhostCmd + appCmd, args: '', guiApp: false }, credential);
    } else {
      // Windows is handled separately
      this.executeAsUser({ ...config, guiApp: false }, credential);
    }
  }

  /**
   * Windows: execute as different user via CreateProcessWithLogonW (koffi FFI).
   *
   * No admin privileges, WinRM, or PSRemoting required.
   * - CLI: wraps in cmd.exe with temp file output redirect
   * - GUI: launches directly (auto window station/desktop ACL setup)
   * - Working directory falls back to C:\Users\Public if target profile doesn't exist
   */
  private executeAsUserWindows(config: CommandConfig, credential: CommandCredential): void {
    const fullCommand = config.args
      ? `${config.command} ${config.args}`
      : config.command;

    const preferredCwd = config.workingDir || `C:\\Users\\${credential.username}`;
    const fallbackCwd = 'C:\\Users\\Public';
    const resolvedCwd = fs.existsSync(preferredCwd) ? preferredCwd : fallbackCwd;

    // Async execution — fire and forget, events handle lifecycle
    (async () => {
      try {
        const { createProcessAsUser } = await getWin32();

        // Check if cancelled before the async import resolved
        if (this._status !== 'running') return;

        const result = await createProcessAsUser({
          username: credential.username,
          domain: credential.domain || '.',
          password: credential.password,
          commandLine: fullCommand,
          cwd: resolvedCwd,
          guiApp: config.guiApp,
          timeoutMs: config.timeout ? config.timeout * 1000 : 0,
          onProcessCreated: (handle) => { this.win32ProcessHandle = handle; },
        });

        if (result.output) this.appendOutput(result.output);
        // Guard against double-exit if cancel() already fired
        if (this._status === 'running') {
          this._exitCode = result.exitCode;
          this._status = 'exited';
          this.emit('exit', result.exitCode);
        }
      } catch (err) {
        if (this._status !== 'running') return; // Already cancelled
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('timed out')) {
          this._status = 'timeout';
          this.appendOutput(`\r\n[Timed out after ${config.timeout}s]\r\n`);
        } else {
          this._status = 'error';
          this._error = message;
        }
        this.emit('error', this._error ?? message);
      } finally {
        this.win32ProcessHandle = null;
      }
    })();
  }

  /**
   * Cancel the running command.
   */
  cancel(): void {
    this.clearTimeout();

    if (this.ptyProcess) {
      this.ptyProcess.kill();
      this.ptyProcess = null;
    }

    if (this.childProcess) {
      this.childProcess.kill('SIGTERM');
      // Escalate to SIGKILL after 5 seconds
      setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGKILL');
        }
      }, 5000);
    }

    // Windows: terminate via per-session Win32 handle if active
    if (os.platform() === 'win32' && this.win32ProcessHandle && win32) {
      win32.terminateProcess(this.win32ProcessHandle);
      this.win32ProcessHandle = null;
    }

    if (this._status === 'running') {
      this._status = 'exited';
      this._exitCode = -1;
      this.emit('exit', -1);
    }
  }

  // ---------- Private helpers ----------

  private buildFullCommand(config: CommandConfig): string {
    const shell = config.shell || '';
    const cmd = config.args ? `${config.command} ${config.args}` : config.command;

    if (shell) {
      return `${shell} -c '${cmd.replace(/'/g, "'\\''")}'`;
    }
    return cmd;
  }

  private isPasswordPrompt(data: string): boolean {
    const lower = data.toLowerCase();
    return lower.includes('password:') || lower.includes('password for') || lower.includes('enter the password');
  }

  private hasReceivedOutput(): boolean {
    return this.outputBuffer.length > 0;
  }

  private appendOutput(data: string): void {
    // Enforce buffer size limit
    const dataBytes = Buffer.byteLength(data, 'utf-8');
    while (this.currentBufferBytes + dataBytes > this.maxBufferBytes && this.outputBuffer.length > 0) {
      const removed = this.outputBuffer.shift()!;
      this.currentBufferBytes -= Buffer.byteLength(removed, 'utf-8');
    }

    this.outputBuffer.push(data);
    this.currentBufferBytes += dataBytes;
    this.emit('data', data);
  }

  private setupTimeout(timeoutSec?: number): void {
    if (!timeoutSec || timeoutSec <= 0) return;

    this.timeoutHandle = setTimeout(() => {
      if (this._status === 'running') {
        this._status = 'timeout';
        this.appendOutput(`\r\n[Timed out after ${timeoutSec}s]\r\n`);
        this.cancel();
      }
    }, timeoutSec * 1000);
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}

// ---------- CommandExecutor (manager) ----------

export class CommandExecutor {
  private sessions = new Map<string, CommandSession>();

  execute(
    id: string,
    config: CommandConfig,
    credential?: CommandCredential,
  ): CommandSession {
    // Close existing session with same id
    this.close(id);

    const session = new CommandSession(id);
    this.sessions.set(id, session);

    if (config.runAsMode === 'current' || !credential) {
      session.executeAsCurrent(config);
    } else {
      session.executeAsUser(config, credential);
    }

    return session;
  }

  getSession(id: string): CommandSession | undefined {
    return this.sessions.get(id);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.cancel();
    return true;
  }

  getOutput(id: string): CommandResult | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    return session.getResult();
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      if (session.isRunning) {
        session.cancel();
      }
      session.removeAllListeners();
      this.sessions.delete(id);
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }
}
