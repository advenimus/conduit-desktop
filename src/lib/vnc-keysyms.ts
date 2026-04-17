/**
 * VNC keysym helpers for the renderer process.
 *
 * Used by VncView's MCP action handler to convert key names and characters
 * to X11 keysyms for noVNC's rfb.sendKey().
 */

/** Standard X11 keysym values for special keys */
export const Keysyms = {
  BackSpace: 0xFF08,
  Tab: 0xFF09,
  Return: 0xFF0D,
  Escape: 0xFF1B,
  Delete: 0xFFFF,
  Insert: 0xFF63,
  Home: 0xFF50,
  End: 0xFF57,
  PageUp: 0xFF55,
  PageDown: 0xFF56,
  Left: 0xFF51,
  Up: 0xFF52,
  Right: 0xFF53,
  Down: 0xFF54,
  Shift_L: 0xFFE1,
  Shift_R: 0xFFE2,
  Control_L: 0xFFE3,
  Control_R: 0xFFE4,
  Alt_L: 0xFFE9,
  Alt_R: 0xFFEA,
  Meta_L: 0xFFEB,
  Meta_R: 0xFFEC,
  CapsLock: 0xFFE5,
  NumLock: 0xFF7F,
  F1: 0xFFBE,
  F2: 0xFFBF,
  F3: 0xFFC0,
  F4: 0xFFC1,
  F5: 0xFFC2,
  F6: 0xFFC3,
  F7: 0xFFC4,
  F8: 0xFFC5,
  F9: 0xFFC6,
  F10: 0xFFC7,
  F11: 0xFFC8,
  F12: 0xFFC9,
  Space: 0x0020,
  Print: 0xFF61,
  Pause: 0xFF13,
  ScrollLock: 0xFF14,
} as const;

const KEY_NAME_TO_KEYSYM: Record<string, number> = {
  'Backspace': Keysyms.BackSpace,
  'Tab': Keysyms.Tab,
  'Enter': Keysyms.Return,
  'Return': Keysyms.Return,
  'Escape': Keysyms.Escape,
  'Esc': Keysyms.Escape,
  'Delete': Keysyms.Delete,
  'Del': Keysyms.Delete,
  'Insert': Keysyms.Insert,
  'Ins': Keysyms.Insert,
  'Home': Keysyms.Home,
  'End': Keysyms.End,
  'PageUp': Keysyms.PageUp,
  'PageDown': Keysyms.PageDown,
  'ArrowLeft': Keysyms.Left,
  'ArrowUp': Keysyms.Up,
  'ArrowRight': Keysyms.Right,
  'ArrowDown': Keysyms.Down,
  'Left': Keysyms.Left,
  'Up': Keysyms.Up,
  'Right': Keysyms.Right,
  'Down': Keysyms.Down,
  'Shift': Keysyms.Shift_L,
  'ShiftLeft': Keysyms.Shift_L,
  'ShiftRight': Keysyms.Shift_R,
  'Control': Keysyms.Control_L,
  'ControlLeft': Keysyms.Control_L,
  'ControlRight': Keysyms.Control_R,
  'Ctrl': Keysyms.Control_L,
  'Alt': Keysyms.Alt_L,
  'AltLeft': Keysyms.Alt_L,
  'AltRight': Keysyms.Alt_R,
  'Meta': Keysyms.Meta_L,
  'MetaLeft': Keysyms.Meta_L,
  'MetaRight': Keysyms.Meta_R,
  'Win': Keysyms.Meta_L,
  'Super': Keysyms.Meta_L,
  'CapsLock': Keysyms.CapsLock,
  'NumLock': Keysyms.NumLock,
  'F1': Keysyms.F1,
  'F2': Keysyms.F2,
  'F3': Keysyms.F3,
  'F4': Keysyms.F4,
  'F5': Keysyms.F5,
  'F6': Keysyms.F6,
  'F7': Keysyms.F7,
  'F8': Keysyms.F8,
  'F9': Keysyms.F9,
  'F10': Keysyms.F10,
  'F11': Keysyms.F11,
  'F12': Keysyms.F12,
  ' ': Keysyms.Space,
  'Space': Keysyms.Space,
  'PrintScreen': Keysyms.Print,
  'Pause': Keysyms.Pause,
  'ScrollLock': Keysyms.ScrollLock,
};

/**
 * Convert a JavaScript key name to an X11 keysym.
 * For single characters, returns the Unicode code point.
 */
export function keyToKeysym(key: string): number {
  const mapped = KEY_NAME_TO_KEYSYM[key];
  if (mapped !== undefined) return mapped;
  if (key.length === 1) return charToKeysym(key);
  return 0;
}

/**
 * Convert a single character to its X11 keysym.
 * ASCII maps directly; non-ASCII uses 0x01000000 | codePoint.
 */
export function charToKeysym(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint < 0x100) return codePoint;
  return 0x01000000 | codePoint;
}

const SHIFTED_CHARS = new Set('~!@#$%^&*()_+{}|:"<>?');

/**
 * Determine if a character needs Shift to be pressed.
 */
export function needsShift(char: string): boolean {
  if (char.length !== 1) return false;
  return char !== char.toLowerCase() || SHIFTED_CHARS.has(char);
}
