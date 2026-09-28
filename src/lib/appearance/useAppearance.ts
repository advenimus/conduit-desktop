/**
 * Appearance runtime (spec 6.2). boot-inline.js paints the first frame; this hook keeps <html>, the
 * localStorage mirror, the icon pack and Electron's native theme in sync afterwards. The title bar colors
 * are sent by src/lib/window-chrome.ts from conduit:appearance-applied, never from here.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { migrateAppearanceStorage } from "./migrate";
import {
  applyAppearanceAttributes,
  isDensity,
  isIconPackId,
  isSchemeId,
  isThemePreference,
  readStoredAppearance,
  resolveMode,
  safeLocalStorage,
  systemPrefersDark,
  writeStoredAppearance,
  type AppearanceState,
  type ResolvedMode,
  type ThemePreference,
} from "./dom";
import { setIconPack, useIconPackStore } from "../icons";
import type { SchemeId } from "../schemes";
import type { IconPackId } from "../icons/types";
import type { Density } from "../../styles/metrics";

export const APPEARANCE_APPLIED_EVENT = "conduit:appearance-applied";
export const THEME_CHANGE_EVENT = "conduit:theme-change";
export const RESOLVED_THEME_EVENT = "conduit:resolved-theme-change";

export interface AppearanceAppliedDetail {
  scheme: SchemeId;
  mode: ResolvedMode;
  density: Density;
  iconPack: IconPackId;
}

/** Detail of conduit:theme-change; every key is optional and unknown values are ignored. */
export interface ThemeChangeDetail {
  theme?: string;
  colorScheme?: string;
  iconPack?: string;
  density?: string;
}

export type { AppearanceState, ThemePreference, ResolvedMode };

function merge(prev: AppearanceState, next: Partial<Record<keyof AppearanceState, unknown>>): AppearanceState {
  const merged: AppearanceState = {
    theme: isThemePreference(next.theme) ? next.theme : prev.theme,
    scheme: isSchemeId(next.scheme) ? next.scheme : prev.scheme,
    iconPack: isIconPackId(next.iconPack) ? next.iconPack : prev.iconPack,
    density: isDensity(next.density) ? next.density : prev.density,
  };
  const same = (Object.keys(merged) as Array<keyof AppearanceState>).every((key) => merged[key] === prev[key]);
  return same ? prev : merged;
}

function initialAppearance(): AppearanceState {
  const storage = safeLocalStorage();
  migrateAppearanceStorage(storage);
  return readStoredAppearance(storage);
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<AppearanceState>(initialAppearance);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);
  const mode = resolveMode(appearance.theme, prefersDark);
  const { theme, scheme, iconPack, density } = appearance;

  useLayoutEffect(() => {
    applyAppearanceAttributes(document.documentElement, { mode, scheme, density });
    writeStoredAppearance({ theme, scheme, iconPack, density });
    if (useIconPackStore.getState().requested !== iconPack) void setIconPack(iconPack);
    document.dispatchEvent(new CustomEvent(RESOLVED_THEME_EVENT, { detail: mode }));
    const detail: AppearanceAppliedDetail = { scheme, mode, density, iconPack };
    document.dispatchEvent(new CustomEvent(APPEARANCE_APPLIED_EVENT, { detail }));
  }, [theme, mode, scheme, iconPack, density]);

  useEffect(() => {
    window.electron?.send?.("set-native-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
    } catch (error) {
      console.warn("[appearance] Cannot follow the system theme", error);
      return;
    }
    const handler = () => setPrefersDark(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ThemeChangeDetail | null>).detail;
      if (!detail || typeof detail !== "object") return;
      setAppearance((prev) => merge(prev, { theme: detail.theme, scheme: detail.colorScheme, iconPack: detail.iconPack, density: detail.density }));
    };
    document.addEventListener(THEME_CHANGE_EVENT, handler);
    return () => document.removeEventListener(THEME_CHANGE_EVENT, handler);
  }, []);

  // The settings file wins; it differs from localStorage only after the storage was cleared.
  useEffect(() => {
    const invoke = window.electron?.invoke;
    if (typeof invoke !== "function") return;
    let cancelled = false;
    invoke("settings_get", undefined)
      .then((settings) => {
        if (cancelled || !settings || typeof settings !== "object") return;
        const s = settings as Record<string, unknown>;
        setAppearance((prev) => merge(prev, { theme: s.theme, scheme: s.color_scheme, iconPack: s.icon_pack, density: s.ui_density }));
      })
      .catch((error: unknown) => console.warn("[appearance] Could not read the saved appearance settings", error));
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((value: ThemePreference) => setAppearance((prev) => merge(prev, { theme: value })), []);
  const setColorScheme = useCallback((value: SchemeId) => setAppearance((prev) => merge(prev, { scheme: value })), []);
  const setAppearanceIconPack = useCallback((value: IconPackId) => setAppearance((prev) => merge(prev, { iconPack: value })), []);
  const setDensity = useCallback((value: Density) => setAppearance((prev) => merge(prev, { density: value })), []);

  return {
    ...appearance,
    mode,
    setTheme,
    setColorScheme,
    setIconPack: setAppearanceIconPack,
    setDensity,
  };
}
