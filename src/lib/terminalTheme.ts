import type { ITheme } from "@xterm/xterm";

/**
 * Read a CSS custom property from :root, returning a fallback if not yet available.
 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * Convert a hex color (#rrggbb) to rgba with the given alpha.
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Build a terminal theme from live CSS variables.
 * Called on every theme/scheme change so the terminal stays in sync.
 * ANSI colors are kept fixed — they're functional (error = red, etc.).
 */
export function getTerminalTheme(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");

  const bg = cssVar("--c-canvas", isDark ? "#0f172a" : "#f8fafc");
  const fg = cssVar("--c-ink", isDark ? "#f1f5f9" : "#0f172a");
  const muted = cssVar("--c-ink-muted", isDark ? "#94a3b8" : "#64748b");

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: hexToRgba(muted, isDark ? 0.3 : 0.25),

    // ANSI colors — fixed across all schemes
    black: "#1e293b",
    red: isDark ? "#ef4444" : "#dc2626",
    green: isDark ? "#22c55e" : "#16a34a",
    yellow: isDark ? "#eab308" : "#ca8a04",
    blue: isDark ? "#3b82f6" : "#2563eb",
    magenta: isDark ? "#a855f7" : "#9333ea",
    cyan: isDark ? "#06b6d4" : "#0891b2",
    white: "#f1f5f9",
    brightBlack: isDark ? "#475569" : "#64748b",
    brightRed: isDark ? "#f87171" : "#ef4444",
    brightGreen: isDark ? "#4ade80" : "#22c55e",
    brightYellow: isDark ? "#facc15" : "#eab308",
    brightBlue: isDark ? "#60a5fa" : "#3b82f6",
    brightMagenta: isDark ? "#c084fc" : "#a855f7",
    brightCyan: isDark ? "#22d3ee" : "#06b6d4",
    brightWhite: "#ffffff",
  };
}
