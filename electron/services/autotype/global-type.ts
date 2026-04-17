/**
 * OS-level keystroke simulation for typing credentials into external apps.
 *
 * macOS: Uses AppleScript via `osascript` (requires Accessibility permission).
 * Windows: Uses Win32 SendInput via koffi FFI (no child process, no focus stealing).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { systemPreferences, shell } from 'electron';

const execFileAsync = promisify(execFile);

// ── macOS helpers ──────────────────────────────────────────────────────────

/** Escape a string for embedding inside an AppleScript double-quoted string. */
function escapeAppleScript(text: string): string {
  // AppleScript: backslash and double-quote need escaping
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function macTypeText(text: string): Promise<void> {
  const escaped = escapeAppleScript(text);
  await execFileAsync('osascript', [
    '-e',
    `tell application "System Events" to keystroke "${escaped}"`,
  ]);
}

async function macSendTab(): Promise<void> {
  // key code 48 = Tab
  await execFileAsync('osascript', [
    '-e',
    'tell application "System Events" to key code 48',
  ]);
}

async function macSendReturn(): Promise<void> {
  // key code 36 = Return
  await execFileAsync('osascript', [
    '-e',
    'tell application "System Events" to key code 36',
  ]);
}

// ── Windows helpers (Win32 SendInput via koffi) ────────────────────────────

/**
 * Lazily-initialized Windows SendInput bindings.
 * Only loaded on Windows to avoid koffi import on macOS.
 */
let winBindings: {
  SendInput: (nInputs: number, pInputs: unknown[], cbSize: number) => number;
  GetLastError: () => number;
  inputSize: number;
} | null = null;

const INPUT_KEYBOARD = 1;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_KEYUP = 0x0002;
const VK_TAB = 0x09;
const VK_RETURN = 0x0D;

async function getWinBindings() {
  if (winBindings) return winBindings;

  // Dynamic import to avoid loading koffi on macOS
  const koffi = (await import('koffi')).default;

  // Windows INPUT struct on x64 is 40 bytes:
  //   offset 0:  type (DWORD, 4 bytes)
  //   offset 4:  4 bytes alignment padding (union contains ULONG_PTR → 8-byte aligned)
  //   offset 8:  union start — KEYBDINPUT variant:
  //              wVk (2) + wScan (2) + dwFlags (4) + time (4) + [4 pad] + dwExtraInfo (8) = 24 bytes
  //              MOUSEINPUT is 32 bytes, so union is 32 bytes total
  //   Total: 4 + 4 + 32 = 40 bytes
  //
  // cbSize MUST equal sizeof(INPUT) = 40 or SendInput returns 0.
  const INPUT_KBD = koffi.struct('INPUT_KBD', {
    type: 'uint32',         // offset 0
    _alignPad: 'uint32',    // offset 4  — padding between type and union
    // KEYBDINPUT fields (union start at offset 8)
    wVk: 'uint16',          // offset 8
    wScan: 'uint16',        // offset 10
    dwFlags: 'uint32',      // offset 12
    time: 'uint32',         // offset 16
    // koffi auto-pads 4 bytes here for 8-byte alignment of dwExtraInfo
    dwExtraInfo: 'uintptr', // offset 24
    // Pad to match MOUSEINPUT union size (32 bytes from offset 8 → ends at offset 40)
    _pad1: 'uint32',        // offset 32
    _pad2: 'uint32',        // offset 36
  });

  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const SendInput = user32.func(
    'uint32 __stdcall SendInput(uint32 nInputs, INPUT_KBD *pInputs, int32 cbSize)',
  );
  const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');

  const inputSize = koffi.sizeof(INPUT_KBD);

  winBindings = {
    SendInput,
    GetLastError,
    inputSize,
  };
  return winBindings;
}

/** Create a key-down INPUT for a Unicode character. */
function unicodeKeyDown(charCode: number) {
  return {
    type: INPUT_KEYBOARD,
    _alignPad: 0,
    wVk: 0,
    wScan: charCode,
    dwFlags: KEYEVENTF_UNICODE,
    time: 0,
    dwExtraInfo: 0,
    _pad1: 0,
    _pad2: 0,
  };
}

/** Create a key-up INPUT for a Unicode character. */
function unicodeKeyUp(charCode: number) {
  return {
    type: INPUT_KEYBOARD,
    _alignPad: 0,
    wVk: 0,
    wScan: charCode,
    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
    time: 0,
    dwExtraInfo: 0,
    _pad1: 0,
    _pad2: 0,
  };
}

/** Create key-down + key-up INPUTs for a virtual key (Tab, Enter, etc). */
function vkeyDownUp(vk: number) {
  return [
    {
      type: INPUT_KEYBOARD,
      _alignPad: 0,
      wVk: vk,
      wScan: 0,
      dwFlags: 0,
      time: 0,
      dwExtraInfo: 0,
      _pad1: 0,
      _pad2: 0,
    },
    {
      type: INPUT_KEYBOARD,
      _alignPad: 0,
      wVk: vk,
      wScan: 0,
      dwFlags: KEYEVENTF_KEYUP,
      time: 0,
      dwExtraInfo: 0,
      _pad1: 0,
      _pad2: 0,
    },
  ];
}

async function winTypeText(text: string): Promise<void> {
  const { SendInput, GetLastError, inputSize } = await getWinBindings();

  // Build an array of key-down + key-up events for each UTF-16 code unit.
  // KEYEVENTF_UNICODE sends via VK_PACKET / WM_CHAR — works for all characters
  // regardless of keyboard layout, including special password characters.
  const inputs: unknown[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    inputs.push(unicodeKeyDown(code));
    inputs.push(unicodeKeyUp(code));
  }

  if (inputs.length > 0) {
    const sent = SendInput(inputs.length, inputs, inputSize);
    if (sent === 0) {
      const err = GetLastError();
      throw new Error(`SendInput returned 0 (GetLastError=${err}, cbSize=${inputSize}, nInputs=${inputs.length})`);
    }
  }
}

async function winSendTab(): Promise<void> {
  const { SendInput, inputSize } = await getWinBindings();
  const inputs = vkeyDownUp(VK_TAB);
  SendInput(inputs.length, inputs, inputSize);
}

async function winSendReturn(): Promise<void> {
  const { SendInput, inputSize } = await getWinBindings();
  const inputs = vkeyDownUp(VK_RETURN);
  SendInput(inputs.length, inputs, inputSize);
}

// ── macOS Accessibility Permission ─────────────────────────────────────────

/**
 * Check if the app has Accessibility permission on macOS.
 * When `prompt` is true, macOS shows the native "App wants to control your
 * computer" dialog and auto-adds the app to the Accessibility list (toggled off).
 *
 * IMPORTANT: Due to a known Electron/macOS bug, never call this with `false`
 * before calling with `true` in the same process — macOS caches the prompt
 * flag and will never show the dialog if `false` was called first.
 */
function ensureMacAccessibility(): boolean {
  if (process.platform !== 'darwin') return true;
  // Calling with `true` triggers the native prompt if not yet trusted.
  // The app is auto-added to the Accessibility list (user just toggles it on).
  return systemPreferences.isTrustedAccessibilityClient(true);
}

/** Open the Accessibility pane in System Settings as a fallback. */
function openAccessibilitySettings(): void {
  shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

const isMac = process.platform === 'darwin';

/** Type text into the currently focused OS window. */
export async function globalTypeText(text: string): Promise<void> {
  if (isMac && !ensureMacAccessibility()) {
    openAccessibilitySettings();
    throw new Error(
      'Accessibility permission required. Conduit has been added to the Accessibility list — toggle it on in System Settings, then try again.',
    );
  }

  try {
    if (isMac) {
      await macTypeText(text);
    } else {
      await winTypeText(text);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isMac && (msg.includes('not allowed assistive access') || msg.includes('1002'))) {
      openAccessibilitySettings();
      throw new Error(
        'Accessibility permission required. Toggle Conduit on in System Settings → Privacy & Security → Accessibility, then try again.',
      );
    }
    throw new Error(`Global type failed: ${msg}`);
  }
}

/** Send a Tab keystroke to the currently focused OS window. */
export async function globalSendTab(): Promise<void> {
  if (isMac) {
    await macSendTab();
  } else {
    await winSendTab();
  }
}

/** Send a Return/Enter keystroke to the currently focused OS window. */
export async function globalSendReturn(): Promise<void> {
  if (isMac) {
    await macSendReturn();
  } else {
    await winSendReturn();
  }
}
