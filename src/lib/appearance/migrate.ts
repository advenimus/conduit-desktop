/**
 * Renderer side of the appearance migration (spec 6.3). The same rules run before first paint in
 * boot-inline.js and in the main process (electron/services/appearance-migration.ts); the parity test in
 * scripts/__tests__/appearance-migration-parity.test.ts keeps the three equal.
 */
import TABLE from "./migration-table.json";
import type { SchemeId } from "../schemes";
import type { IconPackId } from "../icons/types";

export const APPEARANCE_VERSION = TABLE.version;

export type ThemePreference = "dark" | "light" | "system";

export const APPEARANCE_KEYS = Object.freeze({
  theme: "conduit-theme",
  scheme: "conduit-color-scheme",
  iconPack: "conduit-icon-pack",
  version: "conduit-appearance-version",
});

/** The localStorage mirrors of the retired settings keys, removed at every boot. */
export const RETIRED_STORAGE_KEYS = Object.freeze({
  platform: "conduit-platform-theme",
  density: "conduit-density",
});

export interface RawAppearance {
  appearance_version?: unknown;
  platform_theme?: unknown;
  color_scheme?: unknown;
  icon_pack?: unknown;
  theme?: unknown;
}

export interface MigratedAppearance {
  appearance_version: number;
  color_scheme: SchemeId;
  icon_pack: IconPackId;
  theme: ThemePreference;
}

function pick<T extends string>(value: unknown, allowed: readonly string[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
}

function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** max(2, the stored integer): a higher version was written by a later build and is never written back as 2. */
export function keptVersion(value: unknown): number {
  const stored = Number(value);
  return Number.isInteger(stored) && stored > TABLE.version ? stored : TABLE.version;
}

function retiredOr(scheme: unknown): unknown {
  return typeof scheme === "string" ? (lookup(TABLE.retiredSchemes, scheme) ?? scheme) : scheme;
}

export function migrateAppearance(raw: RawAppearance): MigratedAppearance {
  const d = TABLE.defaults;
  const theme = pick<ThemePreference>(raw.theme, TABLE.themes, d.theme as ThemePreference);
  const appearance_version = keptVersion(raw.appearance_version);

  if (Number(raw.appearance_version) >= TABLE.version) {
    return {
      appearance_version,
      color_scheme: pick<SchemeId>(retiredOr(raw.color_scheme), TABLE.schemes, d.color_scheme as SchemeId),
      icon_pack: pick<IconPackId>(raw.icon_pack, TABLE.iconPacks, d.icon_pack as IconPackId),
      theme,
    };
  }

  const platform = typeof raw.platform_theme === "string" ? raw.platform_theme : TABLE.legacy.platform_theme;
  const scheme = typeof raw.color_scheme === "string" ? raw.color_scheme : TABLE.legacy.color_scheme;
  const untouchedDefault = platform === TABLE.legacy.platform_theme && scheme === TABLE.legacy.color_scheme;
  const nextScheme = lookup(TABLE.retiredSchemes, scheme) ?? (untouchedDefault ? d.color_scheme : scheme);
  const platformPack = lookup(TABLE.packByPlatform, platform) ?? d.icon_pack;

  return {
    appearance_version,
    color_scheme: pick<SchemeId>(nextScheme, TABLE.schemes, d.color_scheme as SchemeId),
    icon_pack: pick<IconPackId>(raw.icon_pack, TABLE.iconPacks, platformPack as IconPackId),
    theme,
  };
}

function read(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch (error) {
    console.warn(`[appearance] Could not read ${key}`, error);
    return null;
  }
}

function write(storage: Storage | null, key: string, value: string | null): void {
  if (!storage) return;
  try {
    if (value === null) storage.removeItem(key);
    else if (storage.getItem(key) !== value) storage.setItem(key, value);
  } catch (error) {
    console.warn(`[appearance] Could not write ${key}`, error);
  }
}

/** Migrates the localStorage mirror in place (idempotent) and returns the result. */
export function migrateAppearanceStorage(storage: Storage | null): MigratedAppearance {
  const result = migrateAppearance({
    appearance_version: read(storage, APPEARANCE_KEYS.version),
    platform_theme: read(storage, RETIRED_STORAGE_KEYS.platform),
    color_scheme: read(storage, APPEARANCE_KEYS.scheme),
    icon_pack: read(storage, APPEARANCE_KEYS.iconPack),
    theme: read(storage, APPEARANCE_KEYS.theme),
  });
  write(storage, APPEARANCE_KEYS.scheme, result.color_scheme);
  write(storage, APPEARANCE_KEYS.iconPack, result.icon_pack);
  write(storage, APPEARANCE_KEYS.theme, result.theme);
  write(storage, APPEARANCE_KEYS.version, String(result.appearance_version));
  write(storage, RETIRED_STORAGE_KEYS.platform, null);
  write(storage, RETIRED_STORAGE_KEYS.density, null);
  return result;
}
