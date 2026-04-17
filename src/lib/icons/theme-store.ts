/**
 * Zustand store for the active icon theme.
 * Synced with the platform theme setting via conduit:platform-theme-change events.
 */

import { create } from "zustand";
import type { IconTheme, ThemeIconDefaults, IconMapping } from "./types";
import { THEME_ICON_DEFAULTS } from "./types";

interface IconThemeState {
  activeTheme: IconTheme;
  defaults: ThemeIconDefaults;
  /** The currently loaded icon mapping (null until first load). */
  mapping: IconMapping | null;
  setTheme: (theme: IconTheme) => void;
  setMapping: (mapping: IconMapping) => void;
}

export const useIconThemeStore = create<IconThemeState>((set) => {
  const saved = localStorage.getItem("conduit-platform-theme") as IconTheme | null;
  const initial: IconTheme = saved ?? "default";

  return {
    activeTheme: initial,
    defaults: THEME_ICON_DEFAULTS[initial] ?? THEME_ICON_DEFAULTS.default,
    mapping: null,
    setTheme: (theme: IconTheme) => {
      set({
        activeTheme: theme,
        defaults: THEME_ICON_DEFAULTS[theme] ?? THEME_ICON_DEFAULTS.default,
      });
    },
    setMapping: (mapping: IconMapping) => {
      set({ mapping });
    },
  };
});
