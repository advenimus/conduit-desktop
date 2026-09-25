// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { ConduitClient } from '../../ipc-client.js';
import { IpcRequestError } from '../../ipc-client.js';
import { isTextResult, textResult } from '../../tool-result.js';
import {
  formatExecuteResult,
  localShellCreate,
  parseKeySequences,
  terminalExecute,
  terminalReadPane,
  terminalSendKeys,
} from '../terminal.js';
import { stripAnsi } from '../terminal-text.js';

const NO_OUTPUT = '(no output)';

function makeClient(overrides: Partial<Record<keyof ConduitClient, unknown>> = {}): ConduitClient {
  return {
    terminalExecute: vi.fn(),
    terminalSendKeys: vi.fn(),
    terminalReadScreen: vi.fn(),
    terminalWrite: vi.fn(),
    terminalReadBuffer: vi.fn(),
    localShellCreate: vi.fn(),
    ...overrides,
  } as unknown as ConduitClient;
}

describe('parseKeySequences', () => {
  it('parses \\x03 as byte 3', () => {
    expect(parseKeySequences('\\x03')).toEqual(Buffer.from([0x03]));
  });

  it('parses \\r \\n \\t \\e and a literal backslash', () => {
    expect(parseKeySequences('\\r')).toEqual(Buffer.from([0x0d]));
    expect(parseKeySequences('\\n')).toEqual(Buffer.from([0x0a]));
    expect(parseKeySequences('\\t')).toEqual(Buffer.from([0x09]));
    expect(parseKeySequences('\\e')).toEqual(Buffer.from([0x1b]));
    expect(parseKeySequences('\\\\')).toEqual(Buffer.from([0x5c]));
  });

  it('parses \\x1b[A (Escape followed by literal chars) as an arrow-up sequence', () => {
    expect(parseKeySequences('\\x1b[A')).toEqual(Buffer.from([0x1b, 0x5b, 0x41]));
  });

  it('sends invalid hex like \\x0G literally', () => {
    // 'G' is not a hex digit, so the parser falls back: backslash literal, then 'x', '0', 'G' as plain chars.
    expect(parseKeySequences('\\x0G')).toEqual(Buffer.from([0x5c, 0x78, 0x30, 0x47]));
  });

  it('sends a trailing lone backslash literally', () => {
    expect(parseKeySequences('a\\')).toEqual(Buffer.from([0x61, 0x5c]));
  });

  it('encodes UTF-8 text including an emoji surrogate pair to correct UTF-8 bytes', () => {
    const input = 'café😀';
    expect(parseKeySequences(input)).toEqual(Buffer.from(input, 'utf8'));
  });
});

describe('stripAnsi', () => {
  it('removes SGR sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('removes erase-line sequences', () => {
    expect(stripAnsi('foo\x1b[Kbar')).toBe('foobar');
  });

  it('removes private-mode sequences (bracketed paste toggle)', () => {
    expect(stripAnsi('\x1b[?2004hprompt$ \x1b[?2004l')).toBe('prompt$ ');
  });

  it('removes an OSC title-setting sequence', () => {
    expect(stripAnsi('\x1b]0;my title\x07$ ')).toBe('$ ');
  });

  it('removes a keypad-mode two-character escape', () => {
    expect(stripAnsi('\x1b=text')).toBe('text');
  });

  it('keeps plain text and newlines', () => {
    expect(stripAnsi('line one\nline two\n')).toBe('line one\nline two\n');
  });
});

describe('terminalExecute', () => {
  it('passes connection_id/command/timeout/shell through with defaults', async () => {
    const execMock = vi.fn().mockResolvedValue({
      status: 'completed',
      started: true,
      exit_code: 0,
      duration_ms: 5,
      stdout: 'ok',
    });
    const client = makeClient({ terminalExecute: execMock });

    await terminalExecute(client, { connection_id: 'sess-1', command: 'echo hi' });

    expect(execMock).toHaveBeenCalledWith('sess-1', 'echo hi', 30_000, 'auto');
  });

  it('clamps timeout_ms to [1000, 600000]', async () => {
    const execMock = vi.fn().mockResolvedValue({ status: 'completed', started: true, exit_code: 0, stdout: 'ok' });
    const client = makeClient({ terminalExecute: execMock });

    await terminalExecute(client, { connection_id: 'a', command: 'x', timeout_ms: 1 });
    expect(execMock).toHaveBeenCalledWith('a', 'x', 1_000, 'auto');

    await terminalExecute(client, { connection_id: 'a', command: 'x', timeout_ms: 999_999_999 });
    expect(execMock).toHaveBeenCalledWith('a', 'x', 600_000, 'auto');
  });

  it('returns a text result with stdout as text and exit metadata', async () => {
    const client = makeClient({
      terminalExecute: vi.fn().mockResolvedValue({
        status: 'completed',
        started: true,
        exit_code: 0,
        duration_ms: 42,
        stdout: 'hello world',
      }),
    });

    const result = await terminalExecute(client, { connection_id: 'a', command: 'echo hello world' });
    expect(isTextResult(result)).toBe(true);
    const tr = result as ReturnType<typeof textResult>;
    expect(tr.text).toBe('hello world');
    expect(tr.metadata.exit_code).toBe(0);
    expect(tr.metadata.status).toBe('completed');
    expect(tr.metadata.timed_out).toBe(false);
    expect(tr.metadata.duration_ms).toBe(42);
  });

  it('returns "(no output)" for empty stdout', async () => {
    const client = makeClient({
      terminalExecute: vi.fn().mockResolvedValue({ status: 'completed', started: true, exit_code: 0, stdout: '' }),
    });
    const result = (await terminalExecute(client, { connection_id: 'a', command: 'true' })) as ReturnType<
      typeof textResult
    >;
    expect(result.text).toBe(NO_OUTPUT);
  });

  it('rejects when connection_id or command is missing or empty', async () => {
    const client = makeClient();
    await expect(terminalExecute(client, { command: 'x' })).rejects.toThrow();
    await expect(terminalExecute(client, { connection_id: '', command: 'x' })).rejects.toThrow();
    await expect(terminalExecute(client, { connection_id: 'a' })).rejects.toThrow();
    await expect(terminalExecute(client, { connection_id: 'a', command: '' })).rejects.toThrow();
  });

  it('rejects on an invalid shell value', async () => {
    const client = makeClient();
    await expect(terminalExecute(client, { connection_id: 'a', command: 'x', shell: 'bash' })).rejects.toThrow();
  });

  it('rejects when timeout_ms is not a number', async () => {
    const client = makeClient();
    await expect(
      terminalExecute(client, { connection_id: 'a', command: 'x', timeout_ms: 'soon' }),
    ).rejects.toThrow();
  });

  it('falls back to the legacy marker-wrapped path on UNKNOWN_REQUEST', async () => {
    let markerId = '';
    const terminalWrite = vi.fn(async (_id: string, data: Buffer) => {
      const match = data.toString().match(/__CONDUIT_START_([0-9a-f]{8})__/);
      markerId = match ? match[1] : '';
    });
    const terminalReadBuffer = vi.fn(async (_id: string, lines: number) => {
      // Readiness probe reads 10 lines; the polling loop reads 500.
      if (lines === 10) return 'user@host:~$ ';
      const start = `__CONDUIT_START_${markerId}__`;
      const end = `__CONDUIT_END_${markerId}_EXIT_`;
      return `${start}\nhello from legacy\n${end}0__\n`;
    });
    const client = makeClient({
      terminalExecute: vi.fn().mockRejectedValue(new IpcRequestError('UNKNOWN_REQUEST', 'no such request')),
      terminalWrite,
      terminalReadBuffer,
    });

    const result = (await terminalExecute(client, {
      connection_id: 'sess-legacy',
      command: 'echo hello from legacy',
    })) as ReturnType<typeof textResult>;

    expect(isTextResult(result)).toBe(true);
    expect(result.text).toBe('hello from legacy');
    expect(result.metadata.exit_code).toBe(0);
    expect(result.metadata.timed_out).toBe(false);
    expect(terminalWrite).toHaveBeenCalledTimes(1);
  });

  it('propagates non-UNKNOWN_REQUEST errors', async () => {
    const client = makeClient({
      terminalExecute: vi.fn().mockRejectedValue(new IpcRequestError('SESSION_BUSY', 'busy')),
    });
    await expect(terminalExecute(client, { connection_id: 'a', command: 'x' })).rejects.toThrow('SESSION_BUSY');
  });
});

describe('formatExecuteResult', () => {
  it('marks timed_out and hints at Ctrl+C when the command started but timed out', () => {
    const result = formatExecuteResult({
      status: 'timed_out',
      started: true,
      exit_code: null,
      duration_ms: 100,
      stdout: 'partial output',
    }) as ReturnType<typeof textResult>;

    expect(result.metadata.timed_out).toBe(true);
    expect(result.metadata.hint).toContain('\\x03');
    expect(result.text).toBe('partial output');
  });

  it('returns the screen and a not-started hint when the shell never started the command', () => {
    const result = formatExecuteResult({
      status: 'timed_out',
      started: false,
      screen: ['>>> '],
    }) as ReturnType<typeof textResult>;

    // formatExecuteResult joins the screen lines and trimEnd()s the result.
    expect(result.text).toBe('>>>');
    expect(result.metadata.hint).toContain('never started the command');
  });

  it('hints at connection_list when the session closed', () => {
    const result = formatExecuteResult({
      status: 'session_closed',
      started: true,
      stdout: '',
    }) as ReturnType<typeof textResult>;

    expect(result.metadata.hint).toContain('connection_list');
    expect(result.text).toBe(NO_OUTPUT);
  });

  it('surfaces truncation metadata and a hint to read in parts', () => {
    const result = formatExecuteResult({
      status: 'completed',
      started: true,
      exit_code: 0,
      stdout: 'abc',
      truncated: true,
      omitted_lines: 10,
    }) as ReturnType<typeof textResult>;

    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.omitted_lines).toBe(10);
    expect(result.metadata.hint).toContain('read it in parts');
  });

  it('has no hint or truncated key when completed and not truncated', () => {
    const result = formatExecuteResult({
      status: 'completed',
      started: true,
      exit_code: 0,
      stdout: 'ok',
    }) as ReturnType<typeof textResult>;

    expect(result.metadata).not.toHaveProperty('hint');
    expect(result.metadata).not.toHaveProperty('truncated');
  });
});

describe('terminalReadPane', () => {
  it('defaults to 50 lines and clamps to a max of 5000', async () => {
    const readScreen = vi.fn().mockResolvedValue({ content: 'x', total_lines: 1, alternate_screen: false });
    const client = makeClient({ terminalReadScreen: readScreen });

    await terminalReadPane(client, { connection_id: 'a' });
    expect(readScreen).toHaveBeenCalledWith('a', 50);

    await terminalReadPane(client, { connection_id: 'a', lines: 999_999 });
    expect(readScreen).toHaveBeenCalledWith('a', 5_000);
  });

  it('returns a text result with total_lines, returned_lines, and alternate_screen', async () => {
    const client = makeClient({
      terminalReadScreen: vi.fn().mockResolvedValue({
        content: 'a\nb\nc',
        total_lines: 100,
        alternate_screen: false,
      }),
    });
    const result = (await terminalReadPane(client, { connection_id: 'a' })) as ReturnType<typeof textResult>;

    expect(result.text).toBe('a\nb\nc');
    expect(result.metadata.total_lines).toBe(100);
    expect(result.metadata.returned_lines).toBe(3);
    expect(result.metadata.alternate_screen).toBe(false);
  });

  it('returns "(empty)" for empty content', async () => {
    const client = makeClient({
      terminalReadScreen: vi.fn().mockResolvedValue({ content: '', total_lines: 0, alternate_screen: false }),
    });
    const result = (await terminalReadPane(client, { connection_id: 'a' })) as ReturnType<typeof textResult>;

    expect(result.text).toBe('(empty)');
    expect(result.metadata.returned_lines).toBe(0);
  });

  it('falls back to terminalReadBuffer and strips ANSI on UNKNOWN_REQUEST', async () => {
    const client = makeClient({
      terminalReadScreen: vi.fn().mockRejectedValue(new IpcRequestError('UNKNOWN_REQUEST', 'no')),
      terminalReadBuffer: vi.fn().mockResolvedValue('\x1b[31mred\x1b[0m line'),
    });
    const result = (await terminalReadPane(client, { connection_id: 'a' })) as ReturnType<typeof textResult>;

    expect(result.text).toBe('red line');
    expect(result.metadata.total_lines).toBe(1);
  });
});

describe('terminalSendKeys', () => {
  it('writes bytes and returns a plain (non-text) result when wait_ms is 0 or omitted', async () => {
    const terminalWrite = vi.fn();
    const terminalSendKeysMock = vi.fn();
    const client = makeClient({ terminalWrite, terminalSendKeys: terminalSendKeysMock });

    const result = await terminalSendKeys(client, { connection_id: 'a', keys: 'yes\\r' });

    expect(isTextResult(result)).toBe(false);
    expect(result).toEqual({ success: true, bytes_sent: 4 });
    expect(terminalWrite).toHaveBeenCalledTimes(1);
    expect(terminalSendKeysMock).not.toHaveBeenCalled();
  });

  it('calls client.terminalSendKeys and returns a text result when wait_ms > 0', async () => {
    const sendKeysMock = vi.fn().mockResolvedValue({ bytes_sent: 3, output: 'ok' });
    const client = makeClient({ terminalSendKeys: sendKeysMock });

    const result = (await terminalSendKeys(client, {
      connection_id: 'a',
      keys: 'go',
      wait_ms: 50,
    })) as ReturnType<typeof textResult>;

    expect(sendKeysMock).toHaveBeenCalledWith('a', expect.any(Buffer), 50);
    expect(isTextResult(result)).toBe(true);
    expect(result.text).toBe('ok');
    expect(result.metadata).toEqual({ success: true, bytes_sent: 3 });
  });

  it('returns the screen as text and marks alternate_screen when a non-empty screen comes back', async () => {
    const client = makeClient({
      terminalSendKeys: vi.fn().mockResolvedValue({ bytes_sent: 1, screen: ['line1', 'line2'] }),
    });

    const result = (await terminalSendKeys(client, {
      connection_id: 'a',
      keys: 'x',
      wait_ms: 10,
    })) as ReturnType<typeof textResult>;

    expect(result.text).toBe('line1\nline2');
    expect(result.metadata.alternate_screen).toBe(true);
  });

  it('clamps wait_ms to a max of 120000', async () => {
    const sendKeysMock = vi.fn().mockResolvedValue({ bytes_sent: 1, output: 'ok' });
    const client = makeClient({ terminalSendKeys: sendKeysMock });

    await terminalSendKeys(client, { connection_id: 'a', keys: 'x', wait_ms: 999_999_999 });
    expect(sendKeysMock).toHaveBeenCalledWith('a', expect.any(Buffer), 120_000);
  });

  it('falls back to write + terminalReadBuffer on UNKNOWN_REQUEST', async () => {
    const terminalWrite = vi.fn();
    const terminalReadBuffer = vi.fn().mockResolvedValue('\x1b[32mgreen output\x1b[0m');
    const client = makeClient({
      terminalSendKeys: vi.fn().mockRejectedValue(new IpcRequestError('UNKNOWN_REQUEST', 'no')),
      terminalWrite,
      terminalReadBuffer,
    });

    // Small wait_ms keeps the real sleep() inside legacySendKeys fast.
    const result = (await terminalSendKeys(client, {
      connection_id: 'a',
      keys: 'x',
      wait_ms: 1,
    })) as ReturnType<typeof textResult>;

    expect(terminalWrite).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('green output');
    expect(result.metadata).toEqual({ success: true, bytes_sent: 1 });
  });
});

describe('localShellCreate', () => {
  it('creates a session and echoes back shell_type/working_directory defaults', async () => {
    const client = makeClient({ localShellCreate: vi.fn().mockResolvedValue('session-123') });
    const result = await localShellCreate(client, {});
    expect(result).toEqual({ session_id: 'session-123', shell_type: 'default', working_directory: null });
  });
});

describe('isTextResult', () => {
  it('returns false for plain objects, null, and strings', () => {
    expect(isTextResult({})).toBe(false);
    expect(isTextResult(null)).toBe(false);
    expect(isTextResult('hello')).toBe(false);
    expect(isTextResult({ metadata: {}, text: 'x' })).toBe(false);
  });

  it('returns true for a value created by textResult()', () => {
    expect(isTextResult(textResult({}, 'hi'))).toBe(true);
  });
});
