import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useSettingsStore } from "../stores/settingsStore";
import { HARDCODED_TERMINAL_DEFAULTS } from "../types/entry";
import { buildTerminalFontStack, loadTerminalFont, sanitizeFontFamily } from "../lib/terminalFont";

// Terminals outlive their views (tab switches reattach them), so a remount must not redraw every glyph again.
const appliedFonts = new WeakMap<Terminal, string>();

/**
 * Puts the font setting on a terminal: waits for the font, swaps the font list, clears the WebGL
 * glyph cache (it holds glyphs drawn in the old font) and refits, since the cell size changes.
 */
export async function applyTerminalFont(
  terminal: Terminal,
  name: string,
  fit: () => void,
  isStale: () => boolean = () => false,
): Promise<void> {
  const safe = sanitizeFontFamily(name);
  const stack = buildTerminalFontStack(safe);
  if (appliedFonts.get(terminal) === stack || (!safe && terminal.options.fontFamily === stack)) return;
  try {
    if (safe) await loadTerminalFont(safe, terminal.options.fontSize ?? HARDCODED_TERMINAL_DEFAULTS.fontSize);
    if (isStale()) return;
    terminal.options.fontFamily = stack;
    terminal.clearTextureAtlas();
    fit();
    appliedFonts.set(terminal, stack);
  } catch (err) {
    console.error("[terminalFont] Could not apply the terminal font:", err);
  }
}

/** Keeps an open terminal on the font from Settings > Sessions > Terminal, live as it is saved. */
export function useTerminalFontFamily(terminal: Terminal | null, fit: () => void): void {
  const fontFamily = useSettingsStore((s) => s.sessionDefaultsTerminal.fontFamily);
  const fitRef = useRef(fit);
  useEffect(() => {
    fitRef.current = fit;
  }, [fit]);

  useEffect(() => {
    if (!terminal) return;
    let stale = false;
    void applyTerminalFont(terminal, fontFamily, () => fitRef.current(), () => stale);
    return () => {
      stale = true;
    };
  }, [terminal, fontFamily]);
}
