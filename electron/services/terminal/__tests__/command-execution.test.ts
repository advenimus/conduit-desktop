// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { CommandExecution, type ExecIo } from '../command-execution.js';

const ID = 'abcdef012345';
const START = `__CONDUIT_START_${ID}__`;
const end = (code: number) => `__CONDUIT_END_${ID}_EXIT_${code}__`;

class FakeIo implements ExecIo {
  written: string[] = [];
  listeners = new Set<(text: string) => void>();
  closeListeners = new Set<() => void>();
  failWrite = false;

  write(text: string): void {
    if (this.failWrite) throw new Error('channel closed');
    this.written.push(text);
  }
  subscribe(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  emit(...chunks: string[]): void {
    for (const chunk of chunks) for (const l of [...this.listeners]) l(chunk);
  }
  close(): void {
    for (const l of [...this.closeListeners]) l();
  }
}

const single = (final: string) => ({ preludes: [], final });

describe('CommandExecution', () => {
  let io: FakeIo;
  let finished: Mock<() => void>;
  let exec: CommandExecution;

  beforeEach(() => {
    vi.useFakeTimers();
    io = new FakeIo();
    finished = vi.fn<() => void>();
    exec = new CommandExecution(io, ID, 'echo hi', finished);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('types the final line with Enter and returns output between the markers', async () => {
    const result = exec.run(single('WRAPPER'), 5_000);
    expect(io.written).toEqual(['WRAPPER\r']);
    io.emit(
      `$ echo '__CONDUIT_%s_${ID}__' START ...\r\n`,
      `\x1b[?2004l\r${START}\r\n`,
      'hello\r\nworld\r\n',
      `\r\n${end(0)}\r\n$ `,
    );
    await expect(result).resolves.toMatchObject({
      status: 'completed',
      stdout: 'hello\nworld',
      exit_code: 0,
      started: true,
      truncated: false,
    });
    expect(finished).toHaveBeenCalledTimes(1);
    expect(exec.active).toBe(false);
    expect(io.listeners.size).toBe(0);
  });

  it('handles markers split across chunks and output without a trailing newline', async () => {
    const result = exec.run(single('X'), 5_000);
    const stream = `${START}\r\nfoo\r\n${end(3)}\r\n`;
    for (const ch of stream) io.emit(ch);
    await expect(result).resolves.toMatchObject({ stdout: 'foo', exit_code: 3 });
  });

  it('strips escape sequences and resolves progress-bar carriage returns', async () => {
    const result = exec.run(single('X'), 5_000);
    io.emit(`${START}\r\n\x1b[32m10%\r50%\r100%\x1b[0m\r\n\x1b[Kok\r\n\r\n${end(0)}\r\n`);
    await expect(result).resolves.toMatchObject({ stdout: '100%\nok' });
  });

  it('times out, stays active, and finishes when the end marker arrives later', async () => {
    const result = exec.run(single('X'), 1_000);
    io.emit(`${START}\r\npartial\r\n`);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({
      status: 'timed_out',
      stdout: 'partial',
      exit_code: null,
      started: true,
    });
    expect(exec.active).toBe(true);
    expect(exec.detached).toBe(true);
    expect(finished).not.toHaveBeenCalled();

    io.emit('more\r\n', `\r\n${end(0)}`, '\r\n');
    expect(finished).toHaveBeenCalledTimes(1);
    expect(exec.active).toBe(false);
  });

  it('reports started=false when the start marker never appears', async () => {
    const result = exec.run(single('X'), 1_000);
    io.emit('>>> ');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ status: 'timed_out', started: false, stdout: '' });
  });

  it('Ctrl+C ends a running command after a short grace period', async () => {
    const result = exec.run(single('X'), 30_000);
    io.emit(`${START}\r\nworking\r\n`);
    exec.interrupt();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toMatchObject({ status: 'interrupted', stdout: 'working', exit_code: null });
    expect(exec.active).toBe(false);
  });

  it('Ctrl+C keeps the real exit code when the shell still prints the end marker', async () => {
    const result = exec.run(single('X'), 30_000);
    io.emit(`${START}\r\n`);
    exec.interrupt();
    io.emit(`^C\r\n${end(130)}\r\n`);
    await expect(result).resolves.toMatchObject({ status: 'completed', exit_code: 130 });
  });

  it('Ctrl+C frees a detached (timed-out) command immediately', async () => {
    const result = exec.run(single('X'), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    exec.interrupt();
    expect(exec.active).toBe(false);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('reports session_closed when the session goes away', async () => {
    const result = exec.run(single('X'), 30_000);
    io.emit(`${START}\r\nbye\r\n`);
    io.close();
    await expect(result).resolves.toMatchObject({ status: 'session_closed', stdout: 'bye' });
    expect(exec.active).toBe(false);
  });

  it('types preludes one at a time, each after its acknowledgement', async () => {
    const preludes = [
      { line: 'P0', ack: `__CONDUIT_ACK_${ID}_0__` },
      { line: 'P1', ack: `__CONDUIT_ACK_${ID}_1__` },
    ];
    const result = exec.run({ preludes, final: 'FINAL' }, 5_000);
    expect(io.written).toEqual(['P0\r']);
    io.emit(`$ P0 echo\r\n__CONDUIT_ACK_${ID}_`);
    expect(io.written).toEqual(['P0\r']);
    io.emit('0__\r\n$ ');
    expect(io.written).toEqual(['P0\r', 'P1\r']);
    io.emit(`__CONDUIT_ACK_${ID}_1__\r\n$ `);
    expect(io.written).toEqual(['P0\r', 'P1\r', 'FINAL\r']);
    io.emit(`${START}\r\nok\r\n\r\n${end(0)}\r\n`);
    await expect(result).resolves.toMatchObject({ status: 'completed', stdout: 'ok' });
  });

  it('rejects and cleans up when the first write fails', async () => {
    io.failWrite = true;
    await expect(exec.run(single('X'), 5_000)).rejects.toThrow('channel closed');
    expect(exec.active).toBe(false);
    expect(io.listeners.size).toBe(0);
  });

  it('refuses to run twice', () => {
    void exec.run(single('X'), 5_000);
    expect(() => exec.run(single('X'), 5_000)).toThrow(/twice/);
  });
});
