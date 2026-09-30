/** Reading, validating and applying the appearance on <html>. Shared by useAppearance and the overlay window. */
import TABLE from "./migration-table.json";
import { APPEARANCE_KEYS, keptVersion, migrateAppearance, type ThemePreference } from "./migrate";
import { isSchemeId, type SchemeId } from "../schemes";
import { isIconPackId, type IconPackId } from "../icons/types";

export type { ThemePreference };
export type ResolvedMode = "dark" | "light";

export interface AppearanceState {
  theme: ThemePreference;
  scheme: SchemeId;
  iconPack: IconPackId;
}

export const DEFAULT_THEME = TABLE.defaults.theme as ThemePreference;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && TABLE.themes.includes(value);
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
    theme: read(storage, APPEARANCE_KEYS.theme),
  });
  return { theme: migrated.theme, scheme: migrated.color_scheme, iconPack: migrated.icon_pack };
}

export function writeStoredAppearance(state: AppearanceState, storage: Storage | null = safeLocalStorage()): void {
  if (!storage) return;
  const entries: Array<[string, string]> = [
    [APPEARANCE_KEYS.theme, state.theme],
    [APPEARANCE_KEYS.scheme, state.scheme],
    [APPEARANCE_KEYS.iconPack, state.iconPack],
    [APPEARANCE_KEYS.version, String(keptVersion(read(storage, APPEARANCE_KEYS.version)))],
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

export function applyAppearanceAttributes(root: HTMLElement, look: { mode: ResolvedMode; scheme: SchemeId }): void {
  const other: ResolvedMode = look.mode === "dark" ? "light" : "dark";
  root.classList.remove(other);
  root.classList.add(look.mode);
  if (root.getAttribute("data-scheme") !== look.scheme) root.setAttribute("data-scheme", look.scheme);
}
