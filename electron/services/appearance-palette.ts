/**
 * The native window background per color scheme and mode (docs/VISUAL_REDESIGN.md 7.2): the resolved
 * --c-shell of each scheme, so a window resized over the UI never flashes another color. These are the
 * `shell` values of src/lib/appearance/shell-colors.json, repeated because Electron code never imports
 * from src/; scripts/__tests__/appearance-palette-parity.test.ts keeps the two equal.
 */

export type PaletteMode = 'dark' | 'light';

export const SHELL_PALETTE = {
  modern: { dark: '#191A1B', light: '#FAFAFD' },
  ocean: { dark: '#1e293b', light: '#f8fafc' },
  ember: { dark: '#1a1210', light: '#fffbf5' },
  forest: { dark: '#12231a', light: '#f2faf5' },
  amethyst: { dark: '#1a1430', light: '#f8f5ff' },
  rose: { dark: '#221418', light: '#fef5f6' },
  midnight: { dark: '#0a1418', light: '#f4fafc' },
} as const satisfies Readonly<Record<string, Readonly<Record<PaletteMode, string>>>>;

export type PaletteScheme = keyof typeof SHELL_PALETTE;

const FALLBACK_SCHEME: PaletteScheme = 'modern';

export interface WindowBackgroundSettings {
  color_scheme?: unknown;
  theme?: unknown;
}

function isPaletteScheme(value: unknown): value is PaletteScheme {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SHELL_PALETTE, value);
}

export function paletteMode(theme: unknown, prefersDark: boolean): PaletteMode {
  if (theme === 'dark' || theme === 'light') return theme;
  return prefersDark ? 'dark' : 'light';
}

/** The background for the saved scheme and mode; an unknown scheme falls back to Modern, `system` follows the OS. */
export function windowBackground(settings: WindowBackgroundSettings | null | undefined, prefersDark: boolean): string {
  const stored = settings?.color_scheme;
  const scheme = isPaletteScheme(stored) ? stored : FALLBACK_SCHEME;
  return SHELL_PALETTE[scheme][paletteMode(settings?.theme, prefersDark)];
}
