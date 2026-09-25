// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fakes = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');

  class FakePty {
    written: string[] = [];
    dataListeners: Array<(d: string) => void> = [];
    exitListeners: Array<(e: { exitCode: number }) => void> = [];
    onData(cb: (d: string) => void) {
      this.dataListeners.push(cb);
      return { dispose() {} };
    }
    onExit(cb: (e: { exitCode: number }) => void) {
      this.exitListeners.push(cb);
      return { dispose() {} };
    }
    write(data: string) {
      this.written.push(data);
    }
    resize() {}
    emit(data: string) {
      for (const cb of this.dataListeners) cb(data);
    }
    exit(exitCode = 0) {
      for (const cb of this.exitListeners) cb({ exitCode });
    }
  }

  class FakeSshSession extends EventEmitter {
    static last: FakeSshSession | null = null;
    written: Buffer[] = [];
    connected = true;
    constructor() {
      super();
      FakeSshSession.last = this;
    }
    async connect() {}
    write(data: Buffer) {
      this.written.push(Buffer.from(data));
    }
    resize() {}
    close() {
      this.emit('close');
    }
  }

  const state = { nextFile: '/bin/zsh', lastPty: null as FakePty | null };
  return { FakePty, FakeSshSession, state };
});

vi.mock('electron', () => ({}));
vi.mock('../pty.js', () => ({
  parseShellType: (s?: string | null) => s ?? 'default',
  createLocalPty: (opts: { command?: string }) => {
    const pty = new fakes.FakePty();
    fakes.state.lastPty = pty;
    return { pty, file: opts.command ?? fakes.state.nextFile, kill: () => pty.exit(0) };
  },
}));
vi.mock('../../ssh/client.js', () => ({ SshSession: fakes.FakeSshSession }));

const { TerminalManager } = await import('../manager.js');
type Manager = InstanceType<typeof TerminalManager>;
type FakePtyT = InstanceType<typeof fakes.FakePty>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

/** Waits for the wrapper to be typed and returns its marker id. */
async function typedMarkerId(pty: FakePtyT, from = 0): Promise<string> {
  const line = await waitFor(() => pty.written.slice(from).find((w) => w.includes('START')));
  return /__CONDUIT_%s_([a-f0-9]{12})__/.exec(line)![1];
}

function finish(pty: FakePtyT, id: string, output: string, code = 0): void {
  pty.emit(`echo of wrapper\r\n__CONDUIT_START_${id}__\r\n${output}\r\n__CONDUIT_END_${id}_EXIT_${code}__\r\n$ `);
}

describe('TerminalManager agent operations', () => {
  let manager: Manager;
  let rendered: Map<string, string>;
  let sessionId: string;
  let pty: FakePtyT;

  const shown = () => rendered.get(sessionId) ?? '';
  const exec = (command: string, timeoutMs = 5_000, shell: 'auto' | 'posix' | 'powershell' = 'auto') =>
    manager.execute(sessionId, { command, timeoutMs, shell });

  async function openShell(file = '/bin/zsh', prompt = '\x1b[?2004h$ '): Promise<void> {
    fakes.state.nextFile = file;
    sessionId = manager.createLocalShell(null, null);
    pty = fakes.state.lastPty!;
    manager.startReading(sessionId);
    pty.emit(prompt);
    await sleep(350);
  }

  beforeEach(() => {
    rendered = new Map();
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: { sessionId: string; data: number[] }) => {
          if (channel !== 'terminal:data') return;
          const text = Buffer.from(payload.data).toString('utf8');
          rendered.set(payload.sessionId, (rendered.get(payload.sessionId) ?? '') + text);
        },
      },
    };
    manager = new TerminalManager(() => win as never);
  });

  afterEach(() => manager.dispose());

  it('runs a command and shows it to the user as if typed', async () => {
    await openShell();
    const pending = exec('ls -la');
    const id = await typedMarkerId(pty);
    expect(pty.written[0].startsWith('\x1b[200~')).toBe(true);
    finish(pty, id, 'file-a\r\nfile-b\r\n');

    await expect(pending).resolves.toMatchObject({ status: 'completed', stdout: 'file-a\nfile-b', exit_code: 0 });
    await sleep(120);
    expect(shown()).toContain('$ ls -la\r\nfile-a\r\nfile-b\r\n');
    expect(shown()).not.toContain('__CONDUIT');
    expect(shown()).not.toContain('echo of wrapper');
  });

  it('rejects a second command while one is running', async () => {
    await openShell();
    const first = exec('sleep 1');
    const id = await typedMarkerId(pty);
    await expect(exec('echo 2')).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    finish(pty, id, '');
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    const again = exec('echo 3');
    finish(pty, await typedMarkerId(pty, 1), '3\r\n');
    await expect(again).resolves.toMatchObject({ stdout: '3' });
  });

  it('stays busy after a timeout until Ctrl+C is sent', async () => {
    await openShell();
    const slow = exec('sleep 100', 1_000);
    const id = await typedMarkerId(pty);
    pty.emit(`__CONDUIT_START_${id}__\r\n`);
    await expect(slow).resolves.toMatchObject({ status: 'timed_out', started: true, exit_code: null });

    await expect(exec('echo next')).rejects.toThrow(/timed out and is still running/);
    manager.write(sessionId, Uint8Array.from([0x03]));
    const next = exec('echo next');
    finish(pty, await typedMarkerId(pty, 1), 'next\r\n');
    await expect(next).resolves.toMatchObject({ stdout: 'next' });
  });

  it('frees the session when a timed-out command finishes on its own', async () => {
    await openShell();
    const slow = exec('sleep 2', 1_000);
    const id = await typedMarkerId(pty);
    pty.emit(`__CONDUIT_START_${id}__\r\n`);
    await slow;
    pty.emit(`done\r\n\r\n__CONDUIT_END_${id}_EXIT_0__\r\n$ `);
    const next = exec('echo ok');
    finish(pty, await typedMarkerId(pty, 1), 'ok\r\n');
    await expect(next).resolves.toMatchObject({ stdout: 'ok' });
  });

  it('returns the screen when the shell never starts the command', async () => {
    await openShell('/bin/zsh', 'Python 3\r\n>>> ');
    const result = await exec('ls', 1_000);
    expect(result).toMatchObject({ status: 'timed_out', started: false });
    expect(result.screen?.join('\n')).toContain('Python 3');
  });

  it('refuses to type into a full-screen program', async () => {
    await openShell();
    pty.emit('\x1b[?1049h\x1b[Hless screen');
    await expect(exec('ls')).rejects.toMatchObject({ code: 'SCREEN_BUSY' });
    pty.emit('\x1b[?1049l$ ');
    const next = exec('ls');
    finish(pty, await typedMarkerId(pty), 'ok\r\n');
    await expect(next).resolves.toMatchObject({ stdout: 'ok' });
  });

  it('reports unsupported shells instead of typing into them', async () => {
    await openShell('cmd.exe', 'C:\\> ');
    await expect(exec('dir')).rejects.toMatchObject({ code: 'UNSUPPORTED_SHELL' });
    expect(pty.written).toEqual([]);
  });

  it('uses PowerShell syntax when asked, on any session', async () => {
    await openShell('/bin/bash', '$ ');
    const pending = exec("'hi'", 5_000, 'powershell');
    const line = await waitFor(() => pty.written.find((w) => w.includes('FromBase64String')));
    const id = /START_([a-f0-9]{12})__/.exec(line)![1];
    finish(pty, id, 'hi\r\n');
    await expect(pending).resolves.toMatchObject({ stdout: 'hi' });
  });

  it('agent CLI terminals are not shells', async () => {
    sessionId = manager.createAgentTerminal({ command: 'claude' });
    await expect(exec('ls')).rejects.toMatchObject({ code: 'UNSUPPORTED_SHELL' });
  });

  it('reports session_closed when the shell exits mid-command', async () => {
    await openShell();
    const pending = exec('exit');
    const id = await typedMarkerId(pty);
    pty.emit(`__CONDUIT_START_${id}__\r\nlogout\r\n`);
    pty.exit(0);
    await expect(pending).resolves.toMatchObject({ status: 'session_closed', stdout: 'logout' });
  });

  it('send_keys with wait returns the response once output settles', async () => {
    await openShell();
    setTimeout(() => pty.emit('print(1)\r\n1\r\n>>> '), 50);
    const result = await manager.sendKeys(sessionId, Buffer.from('print(1)\r'), { waitMs: 3_000, idleMs: 150 });
    expect(pty.written).toContain('print(1)\r');
    expect(result).toMatchObject({ bytes_sent: 9, output: 'print(1)\n1\n>>>', truncated: false });
    expect(result.screen).toBeUndefined();
  });

  it('send_keys includes the screen while a full-screen program is open', async () => {
    await openShell();
    setTimeout(() => pty.emit('\x1b[?1049h\x1b[HMENU\r\n> item 1'), 30);
    const result = await manager.sendKeys(sessionId, Buffer.from('\x1b[B'), { waitMs: 2_000, idleMs: 100 });
    expect(result.screen?.[0]).toBe('MENU');
  });

  it('read screen returns what the user sees', async () => {
    await openShell();
    pty.emit('\r\n\x1b[31mred\x1b[0m text\r\n$ ');
    const snap = await manager.readScreen(sessionId, 10);
    expect(snap.lines).toEqual(['$', 'red text', '$']);
  });

  it('keeps multi-byte characters intact across SSH chunk boundaries', async () => {
    sessionId = await manager.createSshSession({ host: 'h', auth: { type: 'password', username: 'u', password: 'p' } });
    const ssh = fakes.FakeSshSession.last!;
    const bytes = Buffer.from('héllo ✓\r\n', 'utf8');
    ssh.emit('data', bytes.subarray(0, 2));
    ssh.emit('data', bytes.subarray(2, 9));
    ssh.emit('data', bytes.subarray(9));
    const snap = await manager.readScreen(sessionId, 5);
    expect(snap.lines[0]).toBe('héllo ✓');
  });

  it('throws SESSION_NOT_FOUND for unknown sessions', async () => {
    await expect(manager.execute('nope', { command: 'ls', timeoutMs: 1_000, shell: 'auto' }))
      .rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});
