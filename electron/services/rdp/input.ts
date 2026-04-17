/**
 * RDP input handling — keyboard scancodes and text typing.
 *
 * Works with the RdpSession's scancode API:
 *   - sendKeyEventScancode(code, isPressed, extended)
 *
 * Mouse input is handled directly by RdpSession via the RDP engine.
 */

export type MouseButton = 'left' | 'right' | 'middle';

/** Interface for objects that can send raw scancode key events */
export interface ScancodeInput {
  sendKeyEventScancode(code: number, isPressed: boolean, extended?: boolean): void;
}

/**
 * Send a key press with modifiers.
 *
 * Presses modifier keys, presses/releases the main key, then releases modifiers.
 */
export function sendKeyWithModifiers(
  client: ScancodeInput,
  key: string,
  modifiers: string[] = [],
): void {
  const { scancode, extended, shift } = keyToScancode(key);

  // Press modifiers
  for (const mod of modifiers) {
    const m = modifierScancode(mod);
    if (m) client.sendKeyEventScancode(m.scancode, true, m.extended);
  }

  // If the character requires shift and shift isn't already in modifiers
  if (shift && !modifiers.includes('shift')) {
    client.sendKeyEventScancode(0x2a, true, false); // Left Shift down
  }

  // Press+release key
  client.sendKeyEventScancode(scancode, true, extended);
  client.sendKeyEventScancode(scancode, false, extended);

  // Release shift if we added it
  if (shift && !modifiers.includes('shift')) {
    client.sendKeyEventScancode(0x2a, false, false); // Left Shift up
  }

  // Release modifiers in reverse
  for (let i = modifiers.length - 1; i >= 0; i--) {
    const m = modifierScancode(modifiers[i]);
    if (m) client.sendKeyEventScancode(m.scancode, false, m.extended);
  }
}

/**
 * Type a string character by character.
 *
 * Uses scancode events for standard ASCII characters.
 */
export async function sendText(
  client: ScancodeInput,
  text: string,
  delayMs: number = 20,
): Promise<void> {
  for (const char of text) {
    const { scancode, extended, shift } = charToScancode(char);

    if (shift) {
      client.sendKeyEventScancode(0x2a, true, false); // Shift down
    }
    client.sendKeyEventScancode(scancode, true, extended);
    client.sendKeyEventScancode(scancode, false, extended);
    if (shift) {
      client.sendKeyEventScancode(0x2a, false, false); // Shift up
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modifierScancode(mod: string): { scancode: number; extended: boolean } | null {
  switch (mod.toLowerCase()) {
    case 'ctrl':
    case 'control':
      return { scancode: 0x1d, extended: false }; // Left Ctrl
    case 'alt':
      return { scancode: 0x38, extended: false }; // Left Alt
    case 'shift':
      return { scancode: 0x2a, extended: false }; // Left Shift
    case 'meta':
    case 'win':
    case 'super':
      return { scancode: 0x5b, extended: true }; // Left Win
    default:
      return null;
  }
}

/**
 * Map a DOM-style key name (e.g., "Enter", "a", "F5") to a PS/2 scancode.
 */
function keyToScancode(key: string): { scancode: number; extended: boolean; shift: boolean } {
  // Single character — use charToScancode
  if (key.length === 1) {
    return charToScancode(key);
  }

  // Special keys + common aliases that AI models send
  const special: Record<string, { scancode: number; extended: boolean }> = {
    'Backspace': { scancode: 0x0e, extended: false },
    'Tab': { scancode: 0x0f, extended: false },
    'Enter': { scancode: 0x1c, extended: false },
    'Return': { scancode: 0x1c, extended: false },
    'Escape': { scancode: 0x01, extended: false },
    'Esc': { scancode: 0x01, extended: false },
    'Space': { scancode: 0x39, extended: false },
    'Delete': { scancode: 0x53, extended: true },
    'Del': { scancode: 0x53, extended: true },
    'Insert': { scancode: 0x52, extended: true },
    'Ins': { scancode: 0x52, extended: true },
    'Home': { scancode: 0x47, extended: true },
    'End': { scancode: 0x4f, extended: true },
    'PageUp': { scancode: 0x49, extended: true },
    'PageDown': { scancode: 0x51, extended: true },
    // Arrow keys — DOM-style and common aliases
    'ArrowLeft': { scancode: 0x4b, extended: true },
    'ArrowUp': { scancode: 0x48, extended: true },
    'ArrowRight': { scancode: 0x4d, extended: true },
    'ArrowDown': { scancode: 0x50, extended: true },
    'Left': { scancode: 0x4b, extended: true },
    'Up': { scancode: 0x48, extended: true },
    'Right': { scancode: 0x4d, extended: true },
    'Down': { scancode: 0x50, extended: true },
    // Function keys
    'F1': { scancode: 0x3b, extended: false },
    'F2': { scancode: 0x3c, extended: false },
    'F3': { scancode: 0x3d, extended: false },
    'F4': { scancode: 0x3e, extended: false },
    'F5': { scancode: 0x3f, extended: false },
    'F6': { scancode: 0x40, extended: false },
    'F7': { scancode: 0x41, extended: false },
    'F8': { scancode: 0x42, extended: false },
    'F9': { scancode: 0x43, extended: false },
    'F10': { scancode: 0x44, extended: false },
    'F11': { scancode: 0x57, extended: false },
    'F12': { scancode: 0x58, extended: false },
    // Lock/toggle keys
    'CapsLock': { scancode: 0x3a, extended: false },
    'NumLock': { scancode: 0x45, extended: false },
    'ScrollLock': { scancode: 0x46, extended: false },
    'PrintScreen': { scancode: 0x37, extended: true },
    'Pause': { scancode: 0x45, extended: true },
    // Modifier keys (when sent as the main key, not as a modifier)
    'Control': { scancode: 0x1d, extended: false },
    'ControlLeft': { scancode: 0x1d, extended: false },
    'ControlRight': { scancode: 0x1d, extended: true },
    'Ctrl': { scancode: 0x1d, extended: false },
    'Alt': { scancode: 0x38, extended: false },
    'AltLeft': { scancode: 0x38, extended: false },
    'AltRight': { scancode: 0x38, extended: true },
    'Shift': { scancode: 0x2a, extended: false },
    'ShiftLeft': { scancode: 0x2a, extended: false },
    'ShiftRight': { scancode: 0x36, extended: false },
    // Windows/Meta keys — common AI model variants
    'Meta': { scancode: 0x5b, extended: true },
    'MetaLeft': { scancode: 0x5b, extended: true },
    'MetaRight': { scancode: 0x5c, extended: true },
    'Win': { scancode: 0x5b, extended: true },
    'Win_L': { scancode: 0x5b, extended: true },
    'Win_R': { scancode: 0x5c, extended: true },
    'Super': { scancode: 0x5b, extended: true },
    'Super_L': { scancode: 0x5b, extended: true },
    'Super_R': { scancode: 0x5c, extended: true },
    'ContextMenu': { scancode: 0x5d, extended: true },
  };

  const entry = special[key];
  if (entry) {
    return { ...entry, shift: false };
  }

  // Log unrecognized key name (helps debug AI model key name issues)
  console.warn(`[rdp:input] Unrecognized key name "${key}", falling back to Space`);
  return { scancode: 0x39, extended: false, shift: false };
}

/**
 * Map an ASCII character to a PS/2 scancode.
 */
function charToScancode(c: string): { scancode: number; extended: boolean; shift: boolean } {
  const SCANCODES: Record<string, { scancode: number; shift: boolean }> = {
    // Lowercase letters
    'a': { scancode: 0x1e, shift: false }, 'b': { scancode: 0x30, shift: false },
    'c': { scancode: 0x2e, shift: false }, 'd': { scancode: 0x20, shift: false },
    'e': { scancode: 0x12, shift: false }, 'f': { scancode: 0x21, shift: false },
    'g': { scancode: 0x22, shift: false }, 'h': { scancode: 0x23, shift: false },
    'i': { scancode: 0x17, shift: false }, 'j': { scancode: 0x24, shift: false },
    'k': { scancode: 0x25, shift: false }, 'l': { scancode: 0x26, shift: false },
    'm': { scancode: 0x32, shift: false }, 'n': { scancode: 0x31, shift: false },
    'o': { scancode: 0x18, shift: false }, 'p': { scancode: 0x19, shift: false },
    'q': { scancode: 0x10, shift: false }, 'r': { scancode: 0x13, shift: false },
    's': { scancode: 0x1f, shift: false }, 't': { scancode: 0x14, shift: false },
    'u': { scancode: 0x16, shift: false }, 'v': { scancode: 0x2f, shift: false },
    'w': { scancode: 0x11, shift: false }, 'x': { scancode: 0x2d, shift: false },
    'y': { scancode: 0x15, shift: false }, 'z': { scancode: 0x2c, shift: false },
    // Uppercase letters
    'A': { scancode: 0x1e, shift: true }, 'B': { scancode: 0x30, shift: true },
    'C': { scancode: 0x2e, shift: true }, 'D': { scancode: 0x20, shift: true },
    'E': { scancode: 0x12, shift: true }, 'F': { scancode: 0x21, shift: true },
    'G': { scancode: 0x22, shift: true }, 'H': { scancode: 0x23, shift: true },
    'I': { scancode: 0x17, shift: true }, 'J': { scancode: 0x24, shift: true },
    'K': { scancode: 0x25, shift: true }, 'L': { scancode: 0x26, shift: true },
    'M': { scancode: 0x32, shift: true }, 'N': { scancode: 0x31, shift: true },
    'O': { scancode: 0x18, shift: true }, 'P': { scancode: 0x19, shift: true },
    'Q': { scancode: 0x10, shift: true }, 'R': { scancode: 0x13, shift: true },
    'S': { scancode: 0x1f, shift: true }, 'T': { scancode: 0x14, shift: true },
    'U': { scancode: 0x16, shift: true }, 'V': { scancode: 0x2f, shift: true },
    'W': { scancode: 0x11, shift: true }, 'X': { scancode: 0x2d, shift: true },
    'Y': { scancode: 0x15, shift: true }, 'Z': { scancode: 0x2c, shift: true },
    // Numbers
    '0': { scancode: 0x0b, shift: false }, '1': { scancode: 0x02, shift: false },
    '2': { scancode: 0x03, shift: false }, '3': { scancode: 0x04, shift: false },
    '4': { scancode: 0x05, shift: false }, '5': { scancode: 0x06, shift: false },
    '6': { scancode: 0x07, shift: false }, '7': { scancode: 0x08, shift: false },
    '8': { scancode: 0x09, shift: false }, '9': { scancode: 0x0a, shift: false },
    // Shifted number row
    '!': { scancode: 0x02, shift: true }, '@': { scancode: 0x03, shift: true },
    '#': { scancode: 0x04, shift: true }, '$': { scancode: 0x05, shift: true },
    '%': { scancode: 0x06, shift: true }, '^': { scancode: 0x07, shift: true },
    '&': { scancode: 0x08, shift: true }, '*': { scancode: 0x09, shift: true },
    '(': { scancode: 0x0a, shift: true }, ')': { scancode: 0x0b, shift: true },
    // Whitespace / control
    ' ': { scancode: 0x39, shift: false },
    '\n': { scancode: 0x1c, shift: false },
    '\r': { scancode: 0x1c, shift: false },
    '\t': { scancode: 0x0f, shift: false },
    // Punctuation
    '-': { scancode: 0x0c, shift: false }, '_': { scancode: 0x0c, shift: true },
    '=': { scancode: 0x0d, shift: false }, '+': { scancode: 0x0d, shift: true },
    '[': { scancode: 0x1a, shift: false }, '{': { scancode: 0x1a, shift: true },
    ']': { scancode: 0x1b, shift: false }, '}': { scancode: 0x1b, shift: true },
    ';': { scancode: 0x27, shift: false }, ':': { scancode: 0x27, shift: true },
    "'": { scancode: 0x28, shift: false }, '"': { scancode: 0x28, shift: true },
    ',': { scancode: 0x33, shift: false }, '<': { scancode: 0x33, shift: true },
    '.': { scancode: 0x34, shift: false }, '>': { scancode: 0x34, shift: true },
    '/': { scancode: 0x35, shift: false }, '?': { scancode: 0x35, shift: true },
    '\\': { scancode: 0x2b, shift: false }, '|': { scancode: 0x2b, shift: true },
    '`': { scancode: 0x29, shift: false }, '~': { scancode: 0x29, shift: true },
  };

  const entry = SCANCODES[c];
  if (entry) {
    return { scancode: entry.scancode, extended: false, shift: entry.shift };
  }

  // Fallback to Space
  return { scancode: 0x39, extended: false, shift: false };
}
