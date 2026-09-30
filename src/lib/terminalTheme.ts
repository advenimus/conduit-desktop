import type { ITheme } from "@xterm/xterm";
import { resolveCssColor, type ColorToken } from "./appearance/resolveCssColor";

const FALLBACKS = {
  dark: { "--c-editor": "#121314", "--c-ink": "#ededed", "--c-ink-muted": "#9d9d9d" },
  light: { "--c-editor": "#ffffff", "--c-ink": "#202020", "--c-ink-muted": "#606060" },
} as const;

type TerminalToken = keyof (typeof FALLBACKS)["dark"];

let warned = false;

function tokenColor(token: TerminalToken, mode: "dark" | "light"): string {
  try {
    return resolveCssColor(token as ColorToken);
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("[terminal] Theme tokens are not available yet, using built-in colors", error);
    }
    return FALLBACKS[mode][token];
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Build a terminal theme from live CSS variables. The terminal sits directly under its pane's tab
 * strip, so its background is --c-editor (D-19). Called on every theme/scheme change so the terminal
 * stays in sync.
 * ANSI colors are kept fixed: they're functional (error = red, etc.).
 */
export function getTerminalTheme(): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const mode = isDark ? "dark" : "light";

  const bg = tokenColor("--c-editor", mode);
  const fg = tokenColor("--c-ink", mode);
  const muted = tokenColor("--c-ink-muted", mode);

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: hexToRgba(muted, isDark ? 0.3 : 0.25),

    // ANSI colors: fixed across all schemes
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
