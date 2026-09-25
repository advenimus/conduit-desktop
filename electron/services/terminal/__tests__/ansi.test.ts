// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { AnsiStripper, sanitizeForDisplay, stripAnsi, toPlainText } from '../ansi.js';

describe('stripAnsi', () => {
  it('removes SGR, erase, cursor and private-mode CSI sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[m')).toBe('red green');
    expect(stripAnsi('\x1b[Kmatch\x1b[K')).toBe('match');
    expect(stripAnsi('\x1b[?2004hprompt$ \x1b[?2004l')).toBe('prompt$ ');
    expect(stripAnsi('a\x1b[12;58Hb\x1b[3Cc')).toBe('abc');
  });

  it('removes OSC sequences terminated by BEL or ST', () => {
    expect(stripAnsi('\x1b]0;user@host: ~\x07$ ')).toBe('$ ');
    expect(stripAnsi('\x1b]8;;file:///tmp\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('removes DCS strings and two-character escapes', () => {
    expect(stripAnsi('\x1bP$q"p\x1b\\ok')).toBe('ok');
    expect(stripAnsi('\x1b=\x1b>\x1b(Btext\x1b7\x1b8')).toBe('text');
  });

  it('drops an unfinished sequence at the end', () => {
    expect(stripAnsi('done\x1b[3')).toBe('done');
    expect(stripAnsi('done\x1b]0;tit')).toBe('done');
  });
});

describe('AnsiStripper', () => {
  it('handles sequences split across chunks', () => {
    const s = new AnsiStripper();
    expect(s.push('abc\x1b[3')).toBe('abc');
    expect(s.push('1mred\x1b')).toBe('red');
    expect(s.push('[0m tail')).toBe(' tail');
  });

  it('handles an OSC string split before its ST terminator', () => {
    const s = new AnsiStripper();
    expect(s.push('x\x1b]0;title\x1b')).toBe('x');
    expect(s.push('\\y')).toBe('y');
  });

  it('passes plain text through unchanged', () => {
    const s = new AnsiStripper();
    expect(s.push('héllo ✓\r\n')).toBe('héllo ✓\r\n');
  });
});

describe('toPlainText', () => {
  it('normalizes CRLF and CR+CRLF line endings', () => {
    expect(toPlainText('a\r\nb\r\r\nc')).toBe('a\nb\nc');
  });

  it('keeps the last non-blank carriage-return segment (progress bars)', () => {
    expect(toPlainText('10%\r50%\r100%\ndone')).toBe('100%\ndone');
    expect(toPlainText('text\r\r')).toBe('text');
    expect(toPlainText('keep\r   \r')).toBe('keep');
  });

  it('applies backspaces', () => {
    expect(toPlainText('abx\bc')).toBe('abc');
    expect(toPlainText('✓x\b!')).toBe('✓!');
  });

  it('removes remaining control characters but keeps tabs', () => {
    expect(toPlainText('a\tb\x07c\x00d')).toBe('a\tbcd');
    expect(toPlainText('end\x1b')).toBe('end');
  });

  it('strips escape sequences before rendering', () => {
    expect(toPlainText('\x1b[1mbold\x1b[0m\r\n\x1b[32mok\x1b[0m')).toBe('bold\nok');
  });
});

describe('sanitizeForDisplay', () => {
  it('removes escape and control characters, keeps tabs and newlines', () => {
    expect(sanitizeForDisplay('ls\t-la\r\n\x1b[31mx\x07')).toBe('ls\t-la\n[31mx');
  });
});
