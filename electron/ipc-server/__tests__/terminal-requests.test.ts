// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  parseExecuteRequest,
  parseReadScreenRequest,
  parseSendKeysRequest,
} from '../terminal-requests.js';
import { TerminalError } from '../../services/terminal/errors.js';

const expectInvalid = (fn: () => unknown, message: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TerminalError);
    expect((e as TerminalError).code).toBe('INVALID_ARGUMENT');
    expect((e as TerminalError).message).toMatch(message);
    return;
  }
  throw new Error('expected INVALID_ARGUMENT');
};

describe('parseExecuteRequest', () => {
  it('applies defaults', () => {
    expect(parseExecuteRequest({ session_id: 's1', command: 'ls' })).toEqual({
      sessionId: 's1',
      request: { command: 'ls', timeoutMs: DEFAULT_EXEC_TIMEOUT_MS, shell: 'auto' },
    });
  });

  it('clamps the timeout and maps shell aliases', () => {
    expect(parseExecuteRequest({ session_id: 's', command: 'x', timeout_ms: 5, shell: 'bash' }).request)
      .toEqual({ command: 'x', timeoutMs: 1_000, shell: 'posix' });
    expect(parseExecuteRequest({ session_id: 's', command: 'x', timeout_ms: 9e9, shell: 'PWSH' }).request)
      .toEqual({ command: 'x', timeoutMs: 600_000, shell: 'powershell' });
  });

  it('rejects bad input', () => {
    expectInvalid(() => parseExecuteRequest({ command: 'ls' }), /session_id/);
    expectInvalid(() => parseExecuteRequest({ session_id: 's', command: '   ' }), /command/);
    expectInvalid(() => parseExecuteRequest({ session_id: 's', command: 42 }), /command/);
    expectInvalid(() => parseExecuteRequest({ session_id: 's', command: 'x', shell: 'fish' }), /shell/);
    expectInvalid(() => parseExecuteRequest({ session_id: 's', command: 'x', timeout_ms: 'soon' }), /timeout_ms/);
    expectInvalid(() => parseExecuteRequest({ session_id: 's', command: 'y'.repeat(300_000) }), /Split large/);
  });
});

describe('parseSendKeysRequest', () => {
  it('converts bytes and defaults to not waiting', () => {
    const parsed = parseSendKeysRequest({ session_id: 's', data: [3] });
    expect(parsed).toEqual({ sessionId: 's', data: Uint8Array.from([3]), waitMs: 0, idleMs: undefined });
  });

  it('clamps wait and idle times', () => {
    const parsed = parseSendKeysRequest({ session_id: 's', data: [13], wait_ms: 1e9, idle_ms: 1 });
    expect(parsed.waitMs).toBe(120_000);
    expect(parsed.idleMs).toBe(50);
  });

  it('rejects anything that is not a byte array', () => {
    expectInvalid(() => parseSendKeysRequest({ session_id: 's', data: [] }), /data/);
    expectInvalid(() => parseSendKeysRequest({ session_id: 's', data: 'abc' }), /data/);
    expectInvalid(() => parseSendKeysRequest({ session_id: 's', data: [256] }), /bytes/);
    expectInvalid(() => parseSendKeysRequest({ session_id: 's', data: [1.5] }), /bytes/);
  });
});

describe('parseReadScreenRequest', () => {
  it('defaults and clamps the line count', () => {
    expect(parseReadScreenRequest({ session_id: 's' })).toEqual({ sessionId: 's', lines: 50 });
    expect(parseReadScreenRequest({ session_id: 's', lines: 0 }).lines).toBe(1);
    expect(parseReadScreenRequest({ session_id: 's', lines: 1e6 }).lines).toBe(5_000);
  });
});
