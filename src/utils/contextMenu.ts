/**
 * Popup context menu helper.
 *
 * Shows a styled context menu via a child BrowserWindow (separate OS window)
 * that renders above native WebContentsViews without needing to hide them.
 */

import { invoke } from "../lib/electron";

export interface PopupMenuItem {
  id: string;
  label: string;
  type?: "separator" | "header";
  variant?: "danger";
  icon?: string; // key into SVG icon map (e.g. "play", "edit", "copy", "trash")
  children?: PopupMenuItem[]; // submenu items
}

/** Read current CSS variable values from the document root. */
function getThemeColors(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  return {
    panel: s.getPropertyValue("--c-panel").trim(),
    raised: s.getPropertyValue("--c-raised").trim(),
    ink: s.getPropertyValue("--c-ink").trim(),
    inkFaint: s.getPropertyValue("--c-ink-faint").trim(),
    strokeDim: s.getPropertyValue("--c-stroke-dim").trim(),
  };
}

/**
 * Show a popup context menu at the given position and return the selected item id,
 * or null if dismissed.
 */
export async function showContextMenu(
  x: number,
  y: number,
  items: PopupMenuItem[],
  options?: { anchorRight?: boolean }
): Promise<string | null> {
  const theme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  document.dispatchEvent(
    new CustomEvent("conduit:popup-menu-change", { detail: { open: true } })
  );
  try {
    return await invoke<string | null>("show_context_menu_popup", {
      items,
      x,
      y,
      theme,
      colors: getThemeColors(),
      anchorRight: options?.anchorRight,
    });
  } finally {
    document.dispatchEvent(
      new CustomEvent("conduit:popup-menu-change", { detail: { open: false } })
    );
  }
}
