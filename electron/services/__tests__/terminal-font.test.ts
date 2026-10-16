// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { HARDCODED_TERMINAL_DEFAULTS, withSafeTerminalFont } from '../terminal-font.js';

describe('withSafeTerminalFont', () => {
  it('defaults the terminal font to the built-in fonts', () => {
    expect(HARDCODED_TERMINAL_DEFAULTS).toEqual({ fontSize: 14, scrollback: 10000, cursorBlink: true, fontFamily: '' });
  });

  it('keeps a safe font name, trimmed, without changing the input', () => {
    const input = { theme: 'dark', session_defaults_terminal: { ...HARDCODED_TERMINAL_DEFAULTS, fontFamily: ' Maple Mono NF ' } };
    const out = withSafeTerminalFont(input);
    expect(out.session_defaults_terminal.fontFamily).toBe('Maple Mono NF');
    expect(out.theme).toBe('dark');
    expect(input.session_defaults_terminal.fontFamily).toBe(' Maple Mono NF ');
  });

  it('writes an unsafe or wrong-typed name as the default', () => {
    const unsafe = withSafeTerminalFont({ session_defaults_terminal: { ...HARDCODED_TERMINAL_DEFAULTS, fontFamily: 'a"; b' } });
    expect(unsafe.session_defaults_terminal.fontFamily).toBe('');
    const wrongType = withSafeTerminalFont({ session_defaults_terminal: { ...HARDCODED_TERMINAL_DEFAULTS, fontFamily: 3 as unknown as string } });
    expect(wrongType.session_defaults_terminal.fontFamily).toBe('');
  });

  it('fills the field in for settings saved before it existed', () => {
    const old = { session_defaults_terminal: { fontSize: 16, scrollback: 500, cursorBlink: false } };
    expect(withSafeTerminalFont(old).session_defaults_terminal).toEqual({ fontSize: 16, scrollback: 500, cursorBlink: false, fontFamily: '' });
  });

  it('leaves settings without terminal defaults alone', () => {
    const settings: { theme: string; session_defaults_terminal?: { fontFamily: string } } = { theme: 'light' };
    expect(withSafeTerminalFont(settings)).toBe(settings);
  });
});
