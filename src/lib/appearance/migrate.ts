/**
 * Renderer side of the appearance migration (spec 6.3). The same rules run before first paint in
 * boot-inline.js and in the main process (electron/services/appearance-migration.ts); the parity test in
 * scripts/__tests__/appearance-migration-parity.test.ts keeps the three equal.
 */
import TABLE from "./migration-table.json";
import type { SchemeId } from "../schemes";
import type { IconPackId } from "../icons/types";
import type { Density } from "../../styles/metrics";

export const APPEARANCE_VERSION = TABLE.version;

export const APPEARANCE_KEYS = Object.freeze({
  theme: "conduit-theme",
  scheme: "conduit-color-scheme",
  iconPack: "conduit-icon-pack",
  density: "conduit-density",
  version: "conduit-appearance-version",
});

const LEGACY_PLATFORM_KEY = "conduit-platform-theme";

export interface RawAppearance {
  appearance_version?: unknown;
  platform_theme?: unknown;
  color_scheme?: unknown;
  icon_pack?: unknown;
  ui_density?: unknown;
}

export interface MigratedAppearance {
  appearance_version: number;
  color_scheme: SchemeId;
  icon_pack: IconPackId;
  ui_density: Density;
}

function pick<T extends string>(value: unknown, allowed: readonly string[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : fallback;
}

function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function migrateAppearance(raw: RawAppearance): MigratedAppearance {
  const d = TABLE.defaults;
  const ui_density = pick<Density>(raw.ui_density, TABLE.densities, d.ui_density as Density);

  if (Number(raw.appearance_version) >= TABLE.version) {
    return {
      appearance_version: TABLE.version,
      color_scheme: pick<SchemeId>(raw.color_scheme, TABLE.schemes, d.color_scheme as SchemeId),
      icon_pack: pick<IconPackId>(raw.icon_pack, TABLE.iconPacks, d.icon_pack as IconPackId),
      ui_density,
    };
  }

  const platform = typeof raw.platform_theme === "string" ? raw.platform_theme : TABLE.legacy.platform_theme;
  const scheme = typeof raw.color_scheme === "string" ? raw.color_scheme : TABLE.legacy.color_scheme;
  const untouchedDefault = platform === TABLE.legacy.platform_theme && scheme === TABLE.legacy.color_scheme;
  const nextScheme = lookup(TABLE.retiredSchemes, scheme) ?? (untouchedDefault ? d.color_scheme : scheme);
  const platformPack = lookup(TABLE.packByPlatform, platform) ?? d.icon_pack;

  return {
    appearance_version: TABLE.version,
    color_scheme: pick<SchemeId>(nextScheme, TABLE.schemes, d.color_scheme as SchemeId),
    icon_pack: pick<IconPackId>(raw.icon_pack, TABLE.iconPacks, platformPack as IconPackId),
    ui_density,
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
    platform_theme: read(storage, LEGACY_PLATFORM_KEY),
    color_scheme: read(storage, APPEARANCE_KEYS.scheme),
    icon_pack: read(storage, APPEARANCE_KEYS.iconPack),
    ui_density: read(storage, APPEARANCE_KEYS.density),
  });
  write(storage, APPEARANCE_KEYS.scheme, result.color_scheme);
  write(storage, APPEARANCE_KEYS.iconPack, result.icon_pack);
  write(storage, APPEARANCE_KEYS.density, result.ui_density);
  write(storage, APPEARANCE_KEYS.version, String(result.appearance_version));
  write(storage, LEGACY_PLATFORM_KEY, null);
  return result;
}
