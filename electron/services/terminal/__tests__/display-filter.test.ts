// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DisplayFilter, formatCommandEcho } from '../display-filter.js';

const ID = 'abcdef012345';
const START = `__CONDUIT_START_${ID}__`;
const end = (code: number) => `__CONDUIT_END_${ID}_EXIT_${code}__`;

describe('DisplayFilter', () => {
  let shown: string;
  let filter: DisplayFilter;

  beforeEach(() => {
    vi.useFakeTimers();
    shown = '';
    filter = new DisplayFilter((text) => {
      shown += text;
    });
  });

  afterEach(() => {
    filter.dispose();
    vi.useRealTimers();
  });

  describe('outside an execution', () => {
    it('passes ordinary output through unchanged', () => {
      filter.push('\x1b[32mhello\x1b[0m\r\nworld\r\n$ ');
      expect(shown).toBe('\x1b[32mhello\x1b[0m\r\nworld\r\n$ ');
    });

    it('hides marker lines typed by older MCP clients', () => {
      filter.push(`$ echo '__CONDUIT_START_abc12345__'; ls; echo '__CONDUIT_END_abc12345_EXIT_'"$?"'__'\r\n`);
      filter.push('__CONDUIT_START_abc12345__\r\nfile\r\n__CONDUIT_END_abc12345_EXIT_0__\r\n$ ');
      expect(shown).toBe('file\r\n$ ');
    });

    it('holds a possible partial marker briefly, then releases it', () => {
      filter.push('out\r\n__CON');
      expect(shown).toBe('out\r\n');
      vi.advanceTimersByTime(100);
      expect(shown).toBe('out\r\n__CON');
    });
  });

  describe('during an execution', () => {
    it('replaces the echoed wrapper with the real command and removes the end marker', () => {
      filter.push('$ ');
      filter.beginExec(ID, 'ls -la');
      filter.push(' __conduit_cmd=$(printf ...); printf ... START; ...\r\n');
      filter.push(`\x1b[?2004l\r${START}\r\nfile1\r\nfile2\r\n\r\n${end(0)}\r\n`);
      filter.push('\x1b[?2004h$ ');
      vi.advanceTimersByTime(100);
      expect(shown).toBe('$ \x1b[?2004lls -la\r\nfile1\r\nfile2\r\n\x1b[?2004h$ ');
    });

    it('keeps output that lacks a trailing newline next to the prompt, like a real terminal', () => {
      filter.beginExec(ID, "printf 'foo'");
      filter.push(`echo\r\n${START}\r\nfoo\r\n${end(0)}\r\n$ `);
      expect(shown).toBe("printf 'foo'\r\nfoo$ ");
    });

    it('handles the end marker and its separator split across chunks', () => {
      filter.beginExec(ID, 'echo hi');
      filter.push(`${START}\r\nhi\r\n`);
      filter.push('\r\n');
      filter.push('__CONDUIT_END_');
      filter.push(`${ID}_EXIT_1`);
      filter.push('__\r');
      filter.push('\n$ ');
      expect(shown).toBe('echo hi\r\nhi\r\n$ ');
      expect(shown).not.toContain('__CONDUIT');
    });

    it('releases held trailing newlines when no end marker follows', () => {
      filter.beginExec(ID, 'tail -f log');
      filter.push(`${START}\r\nline\r\n`);
      expect(shown).toBe('tail -f log\r\nline');
      vi.advanceTimersByTime(100);
      expect(shown).toBe('tail -f log\r\nline\r\n');
    });

    it('forwards terminal queries immediately while the echo is hidden', () => {
      filter.beginExec(ID, 'Get-Date');
      filter.push('typed\x1b[6n');
      expect(shown).toBe('\x1b[6n');
    });

    it('shows the held echo if the shell never starts the command', () => {
      filter.beginExec(ID, 'ls');
      filter.push('>>> wrapper text\r\n');
      expect(shown).toBe('');
      vi.advanceTimersByTime(3_000);
      expect(shown).toBe('>>> wrapper text\r\n');
    });

    it('keeps holding while echo keeps arriving (slow line editors)', () => {
      filter.beginExec(ID, 'ls');
      for (let i = 0; i < 5; i++) {
        filter.push('x');
        vi.advanceTimersByTime(2_000);
      }
      expect(shown).toBe('');
      filter.push(`${START}\r\nout\r\n${end(0)}\r\n`);
      expect(shown).toBe('ls\r\nout');
    });

    it('endExec after an interrupt returns to normal pass-through', () => {
      filter.beginExec(ID, 'sleep 100');
      filter.push(`${START}\r\n`);
      filter.push('^C\r\n');
      filter.endExec(ID);
      filter.push('$ ');
      expect(shown).toBe('sleep 100\r\n^C\r\n$ ');
    });
  });
});

describe('formatCommandEcho', () => {
  it('joins lines with CRLF and ends with a line break', () => {
    expect(formatCommandEcho('for i in 1 2; do\n  echo $i\ndone\n')).toBe('for i in 1 2; do\r\n  echo $i\r\ndone\r\n');
  });

  it('limits very long commands', () => {
    const echo = formatCommandEcho(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
    expect(echo.split('\r\n')).toHaveLength(32);
    expect(echo).toContain('… (70 more lines)');
  });

  it('removes escape and control characters from the command', () => {
    expect(formatCommandEcho('echo \x1b[2Jhi\x07')).toBe('echo [2Jhi\r\n');
  });
});
