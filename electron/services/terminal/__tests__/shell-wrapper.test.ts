// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  ackMarker,
  buildPosixChunkedLines,
  buildPosixLine,
  buildPowerShellLine,
  detectShellKind,
  endMarkerPattern,
  escapeForPrintfB,
  normalizeCommand,
  planCommandInput,
  resolveShellFamily,
  startMarker,
} from '../shell-wrapper.js';
import { TerminalError } from '../errors.js';

const ID = 'abcdef012345';
const TRICKY = [
  'echo "hello!world"',
  "echo 'single' \"double\" \\back\\slash",
  'cat <<-EOF\n\tindented\n\tEOF',
  'printf "%s %d\\n" 100% done',
  'echo héllo ✓ 日本 🎉',
  'echo a \\\n  b # trailing comment',
  'sleep 1 &',
].join('\n');

const onPosix = process.platform !== 'win32';

describe('escapeForPrintfB', () => {
  it('produces printable ASCII only', () => {
    expect(escapeForPrintfB(TRICKY)).toMatch(/^[\x20-\x7e]*$/);
  });

  it('escapes quotes, backslashes, bang, newline, tab and non-ASCII', () => {
    expect(escapeForPrintfB("a'b")).toBe("a'\\''b");
    expect(escapeForPrintfB('a\\b')).toBe('a\\\\b');
    expect(escapeForPrintfB('hi!')).toBe('hi\\0041');
    expect(escapeForPrintfB('a\nb\tc')).toBe('a\\nb\\tc');
    expect(escapeForPrintfB('é')).toBe('\\0303\\0251');
    expect(escapeForPrintfB('\x01')).toBe('\\0001');
  });

  it.skipIf(!onPosix)('round-trips exactly through a real printf %b', () => {
    const out = execFileSync('/bin/sh', ['-c', `printf '%b' '${escapeForPrintfB(TRICKY)}'`]);
    expect(out.toString('utf8')).toBe(TRICKY);
  });
});

describe('normalizeCommand', () => {
  it('converts CRLF and lone CR to LF and drops NUL', () => {
    expect(normalizeCommand('a\r\nb\rc\0d')).toBe('a\nb\ncd');
  });
});

describe('buildPosixLine', () => {
  const line = buildPosixLine(TRICKY, ID);

  it('is one physical line of printable ASCII', () => {
    expect(line).toMatch(/^[\x20-\x7e]+$/);
  });

  it('never contains the literal markers, so the echo cannot be mistaken for output', () => {
    expect(line).not.toContain(startMarker(ID));
    expect(endMarkerPattern(ID).test(line)).toBe(false);
  });

  it('starts with a space to stay out of shell history', () => {
    expect(line.startsWith(' ')).toBe(true);
  });

  it.skipIf(!onPosix)('runs the command in sh and prints the markers with the exit code', () => {
    const out = execFileSync('/bin/sh', ['-c', `${buildPosixLine('echo one\necho two; (exit 3)', ID)}`])
      .toString('utf8');
    expect(out).toBe(`${startMarker(ID)}\none\ntwo\n\n__CONDUIT_END_${ID}_EXIT_3__\n`);
  });
});

describe('buildPosixChunkedLines', () => {
  const big = 'cat <<EOF\n' + 'x'.repeat(5_000) + '\nEOF';
  const { preludes, final } = buildPosixChunkedLines(big, ID);

  it('keeps every typed line under the 1024-byte tty and busybox limits', () => {
    expect(preludes.length).toBeGreaterThan(1);
    for (const p of preludes) expect(p.line.length).toBeLessThan(1_000);
    expect(final.length).toBeLessThan(1_000);
  });

  it('acknowledges each piece with its own marker', () => {
    preludes.forEach((p, i) => {
      expect(p.ack).toBe(ackMarker(ID, i));
      expect(p.line).not.toContain(p.ack);
    });
  });

  it('never splits an escape token across pieces', () => {
    const { preludes: ps } = buildPosixChunkedLines('é'.repeat(400), ID);
    for (const p of ps) {
      const payload = /'([^']*)'; printf/.exec(p.line)![1];
      expect(payload).toMatch(/^(\\0\d{3})+$/);
    }
  });

  it.skipIf(!onPosix)('rebuilds and runs the original command in sh', () => {
    const script = [...preludes.map((p) => p.line), final].join('\n');
    const out = execFileSync('/bin/sh', ['-c', script]).toString('utf8');
    expect(out).toContain(`${startMarker(ID)}\n${'x'.repeat(5_000)}\n`);
    expect(out).toContain(`__CONDUIT_END_${ID}_EXIT_0__`);
    preludes.forEach((p) => expect(out).toContain(p.ack));
  });
});

describe('buildPowerShellLine', () => {
  it('carries the command as base64 and builds markers at runtime', () => {
    const line = buildPowerShellLine("'héllo'\nexit 0", ID);
    const b64 = /FromBase64String\('([^']+)'\)/.exec(line)![1];
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe("'héllo'\nexit 0");
    expect(line).not.toContain(startMarker(ID));
    expect(endMarkerPattern(ID).test(line)).toBe(false);
  });
});

describe('planCommandInput', () => {
  it('uses one bracketed paste when the shell supports it', () => {
    const plan = planCommandInput('posix', 'x'.repeat(50_000), ID, true);
    expect(plan.preludes).toEqual([]);
    expect(plan.final.startsWith('\x1b[200~')).toBe(true);
    expect(plan.final.endsWith('\x1b[201~')).toBe(true);
  });

  it('types a short command as a single plain line', () => {
    const plan = planCommandInput('posix', 'ls -la', ID, false);
    expect(plan.preludes).toEqual([]);
    expect(plan.final).toBe(buildPosixLine('ls -la', ID));
  });

  it('splits a long command into acknowledged lines without bracketed paste', () => {
    const plan = planCommandInput('posix', 'y'.repeat(3_000), ID, false);
    expect(plan.preludes.length).toBeGreaterThan(1);
  });

  it('always sends PowerShell as one line', () => {
    const plan = planCommandInput('powershell', 'y'.repeat(3_000), ID, false);
    expect(plan.preludes).toEqual([]);
    expect(plan.final).toContain('FromBase64String');
  });
});

describe('detectShellKind', () => {
  it.each([
    ['/bin/zsh', 'posix'],
    ['/opt/homebrew/bin/bash', 'posix'],
    ['/bin/dash', 'posix'],
    ['powershell.exe', 'powershell'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell'],
    ['cmd.exe', 'cmd'],
    ['/usr/local/bin/fish', 'fish'],
    ['/bin/tcsh', 'unknown'],
  ])('%s → %s', (shell, kind) => {
    expect(detectShellKind(shell)).toBe(kind);
  });
});

describe('resolveShellFamily', () => {
  it('honors an explicit preference', () => {
    expect(resolveShellFamily('powershell', 'posix')).toBe('powershell');
    expect(resolveShellFamily('posix', 'cmd')).toBe('posix');
  });

  it('uses the detected shell for auto', () => {
    expect(resolveShellFamily('auto', 'posix')).toBe('posix');
    expect(resolveShellFamily('auto', 'powershell')).toBe('powershell');
  });

  it.each(['cmd', 'fish', 'unknown'] as const)('rejects %s with guidance', (kind) => {
    expect(() => resolveShellFamily('auto', kind)).toThrow(TerminalError);
    expect(() => resolveShellFamily('auto', kind)).toThrow(/terminal_send_keys/);
  });
});
