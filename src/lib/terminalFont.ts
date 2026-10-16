/**
 * Terminal font family setting: validation, the CSS font list xterm gets, and font discovery.
 * The main process keeps a copy of the validation in electron/services/terminal-font.ts.
 */

export const TERMINAL_FONT_FALLBACK = 'Menlo, Monaco, Consolas, "Courier New", monospace';
export const MAX_FONT_FAMILY_LENGTH = 100;

// The name is wrapped in double quotes inside a CSS font list, so anything that could close the
// quote or start another family or declaration is refused rather than stripped.
const UNSAFE_FONT_CHARS = new Set(['"', "'", "`", ",", ";", "{", "}", "\\", "<", ">"]);

function isUnsafeChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || UNSAFE_FONT_CHARS.has(char);
}

/** The font name to use, or "" for the built-in fonts when the value is empty or unsafe. */
export function sanitizeFontFamily(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const name = raw.trim();
  if (!name || name.length > MAX_FONT_FAMILY_LENGTH) return "";
  return [...name].some(isUnsafeChar) ? "" : name;
}

export function buildTerminalFontStack(name: unknown): string {
  const safe = sanitizeFontFamily(name);
  return safe ? `"${safe}", ${TERMINAL_FONT_FALLBACK}` : TERMINAL_FONT_FALLBACK;
}

/** Waits until the browser has the font ready, so xterm measures its cells with it. */
export async function loadTerminalFont(name: string, sizePx: number): Promise<void> {
  const safe = sanitizeFontFamily(name);
  if (!safe || typeof document.fonts?.load !== "function") return;
  try {
    await document.fonts.load(`${sizePx}px "${safe}"`);
  } catch (err) {
    console.warn(`[terminalFont] Could not load "${safe}"; the terminal uses the next font in the list`, err);
  }
}

interface MeasureContext {
  font: string;
  measureText: (text: string) => { width: number };
}

const PROBE_TEXT = "mmmmmmmmmmlliiWW00OO@#";
const GENERIC_FAMILIES = ["monospace", "serif", "sans-serif"];

function createProbeContext(): MeasureContext | null {
  try {
    return document.createElement("canvas").getContext("2d");
  } catch {
    return null;
  }
}

/**
 * Whether the font is installed, by checking if it changes the width of a probe text against each
 * generic family. Null when it cannot tell (no canvas, or no usable name).
 */
export function isFontInstalled(name: string, ctx: MeasureContext | null = createProbeContext()): boolean | null {
  const safe = sanitizeFontFamily(name);
  if (!safe || !ctx) return null;
  return GENERIC_FAMILIES.some((generic) => {
    ctx.font = `72px ${generic}`;
    const base = ctx.measureText(PROBE_TEXT).width;
    ctx.font = `72px "${safe}", ${generic}`;
    return ctx.measureText(PROBE_TEXT).width !== base;
  });
}

type QueryLocalFonts = () => Promise<ReadonlyArray<{ family: string }>>;

/**
 * The installed font families, each once and sorted, through the Local Font Access API. Null when
 * the system has no such API. Must run from a click; a refused permission rejects.
 */
export async function listInstalledFontFamilies(): Promise<string[] | null> {
  const query = (window as Window & { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof query !== "function") return null;
  const fonts = await query.call(window);
  const families = new Set(fonts.map((font) => font.family).filter(Boolean));
  return [...families].sort((a, b) => a.localeCompare(b));
}
