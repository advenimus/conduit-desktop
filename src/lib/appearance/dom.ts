/** Reading, validating and applying the appearance on <html>. Shared by useAppearance and the overlay window. */
import TABLE from "./migration-table.json";
import { APPEARANCE_KEYS, migrateAppearance } from "./migrate";
import { isSchemeId, type SchemeId } from "../schemes";
import { isIconPackId, type IconPackId } from "../icons/types";
import type { Density } from "../../styles/metrics";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedMode = "dark" | "light";

export interface AppearanceState {
  theme: ThemePreference;
  scheme: SchemeId;
  iconPack: IconPackId;
  density: Density;
}

export const DEFAULT_THEME = TABLE.defaults.theme as ThemePreference;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && TABLE.themes.includes(value);
}

export function isDensity(value: unknown): value is Density {
  return typeof value === "string" && TABLE.densities.includes(value);
}

export { isSchemeId, isIconPackId };

export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn("[appearance] localStorage is not available", error);
    return null;
  }
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch (error) {
    console.warn(`[appearance] Could not read ${key}`, error);
    return null;
  }
}

/** Reads the localStorage mirror without writing to it; unknown values fall back to the defaults. */
export function readStoredAppearance(storage: Storage | null = safeLocalStorage()): AppearanceState {
  const migrated = migrateAppearance({
    appearance_version: read(storage, APPEARANCE_KEYS.version),
    color_scheme: read(storage, APPEARANCE_KEYS.scheme),
    icon_pack: read(storage, APPEARANCE_KEYS.iconPack),
    ui_density: read(storage, APPEARANCE_KEYS.density),
  });
  const theme = read(storage, APPEARANCE_KEYS.theme);
  return {
    theme: isThemePreference(theme) ? theme : DEFAULT_THEME,
    scheme: migrated.color_scheme,
    iconPack: migrated.icon_pack,
    density: migrated.ui_density,
  };
}

export function writeStoredAppearance(state: AppearanceState, storage: Storage | null = safeLocalStorage()): void {
  if (!storage) return;
  const entries: Array<[string, string]> = [
    [APPEARANCE_KEYS.theme, state.theme],
    [APPEARANCE_KEYS.scheme, state.scheme],
    [APPEARANCE_KEYS.iconPack, state.iconPack],
    [APPEARANCE_KEYS.density, state.density],
    [APPEARANCE_KEYS.version, String(TABLE.version)],
  ];
  for (const [key, value] of entries) {
    try {
      if (storage.getItem(key) !== value) storage.setItem(key, value);
    } catch (error) {
      console.warn(`[appearance] Could not save ${key}`, error);
    }
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolveMode(theme: ThemePreference, prefersDark: boolean): ResolvedMode {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

export function applyAppearanceAttributes(root: HTMLElement, look: { mode: ResolvedMode; scheme: SchemeId; density: Density }): void {
  const other: ResolvedMode = look.mode === "dark" ? "light" : "dark";
  root.classList.remove(other);
  root.classList.add(look.mode);
  if (root.getAttribute("data-scheme") !== look.scheme) root.setAttribute("data-scheme", look.scheme);
  if (root.getAttribute("data-density") !== look.density) root.setAttribute("data-density", look.density);
}
