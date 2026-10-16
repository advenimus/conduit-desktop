// Terminal session defaults and font name validation, mirrored from src/types/entry.ts and
// src/lib/terminalFont.ts to avoid cross-boundary imports (src/lib/__tests__/terminalFont.test.ts keeps them equal).

export interface TerminalGlobalDefaults {
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  fontFamily: string;
}

export const HARDCODED_TERMINAL_DEFAULTS: TerminalGlobalDefaults = {
  fontSize: 14, scrollback: 10000, cursorBlink: true, fontFamily: '',
};

const MAX_FONT_FAMILY_LENGTH = 100;
const UNSAFE_FONT_CHARS = new Set(['"', "'", '`', ',', ';', '{', '}', '\\', '<', '>']);

function isUnsafeChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || UNSAFE_FONT_CHARS.has(char);
}

export function sanitizeFontFamily(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = raw.trim();
  if (!name || name.length > MAX_FONT_FAMILY_LENGTH) return '';
  return [...name].some(isUnsafeChar) ? '' : name;
}

/** A copy of the settings whose terminal font is safe to write, so a bad value loads as the default. */
export function withSafeTerminalFont<T extends { session_defaults_terminal?: Partial<TerminalGlobalDefaults> }>(settings: T): T {
  const terminal = settings.session_defaults_terminal;
  if (!terminal) return settings;
  return {
    ...settings,
    session_defaults_terminal: { ...terminal, fontFamily: sanitizeFontFamily(terminal.fontFamily) },
  };
}
