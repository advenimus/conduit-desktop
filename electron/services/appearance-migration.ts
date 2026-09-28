/**
 * Main-process side of the appearance migration (docs/VISUAL_REDESIGN.md 6.3): retired platform themes
 * and native schemes move to the universal schemes and an icon pack. The renderer runs the same rules
 * before first paint (src/lib/appearance); tests keep the table and the behavior equal on both sides.
 * Electron code never imports from src/, so the table is repeated here.
 */

export const APPEARANCE_MIGRATION_TABLE = {
  version: 2,
  schemes: ['modern', 'ocean', 'ember', 'forest', 'amethyst', 'rose', 'midnight'],
  iconPacks: ['codicons', 'lucide', 'tabler', 'phosphor', 'fluent', 'material'],
  densities: ['comfortable', 'compact'],
  themes: ['dark', 'light', 'system'],
  titleBarStyles: ['custom', 'native'],
  defaults: {
    color_scheme: 'modern',
    icon_pack: 'codicons',
    ui_density: 'comfortable',
    theme: 'system',
    title_bar_style: 'custom',
  },
  legacy: {
    platform_theme: 'default',
    color_scheme: 'ocean',
  },
  packByPlatform: {
    macos: 'phosphor',
    windows: 'fluent',
    ubuntu: 'tabler',
  } as Readonly<Record<string, string>>,
  retiredSchemes: {
    'macos-blue': 'modern',
    'macos-graphite': 'modern',
    'win-blue': 'modern',
    'win-sun-valley': 'modern',
    'ubuntu-yaru': 'ember',
    'ubuntu-gnome': 'modern',
  } as Readonly<Record<string, string>>,
} as const;

const TABLE = APPEARANCE_MIGRATION_TABLE;
const LEGACY_KEY = 'platform_theme';

export interface AppearanceSettings {
  appearance_version: number;
  color_scheme: string;
  icon_pack: string;
  ui_density: string;
  title_bar_style: string;
}

export interface AppearanceMigration {
  values: AppearanceSettings;
  /** True when the stored file differs from `values` or still holds platform_theme. */
  changed: boolean;
}

type RawSettings = Record<string, unknown>;

function isRecord(value: unknown): value is RawSettings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function lookup(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Runs on the parsed settings file before defaults are spread over it, so the version check sees raw values. */
export function migrateAppearance(input: unknown): AppearanceMigration {
  const raw = isRecord(input) ? input : {};
  const d = TABLE.defaults;
  const ui_density = pick(raw.ui_density, TABLE.densities, d.ui_density);
  const title_bar_style = pick(raw.title_bar_style, TABLE.titleBarStyles, d.title_bar_style);

  let color_scheme: string;
  let icon_pack: string;
  if (Number(raw.appearance_version) >= TABLE.version) {
    color_scheme = pick(raw.color_scheme, TABLE.schemes, d.color_scheme);
    icon_pack = pick(raw.icon_pack, TABLE.iconPacks, d.icon_pack);
  } else {
    const platform = typeof raw.platform_theme === 'string' ? raw.platform_theme : TABLE.legacy.platform_theme;
    const scheme = typeof raw.color_scheme === 'string' ? raw.color_scheme : TABLE.legacy.color_scheme;
    const untouchedDefault = platform === TABLE.legacy.platform_theme && scheme === TABLE.legacy.color_scheme;
    color_scheme = pick(lookup(TABLE.retiredSchemes, scheme) ?? (untouchedDefault ? d.color_scheme : scheme), TABLE.schemes, d.color_scheme);
    icon_pack = pick(raw.icon_pack, TABLE.iconPacks, lookup(TABLE.packByPlatform, platform) ?? d.icon_pack);
  }

  const values: AppearanceSettings = { appearance_version: TABLE.version, color_scheme, icon_pack, ui_density, title_bar_style };
  const changed =
    Object.prototype.hasOwnProperty.call(raw, LEGACY_KEY) ||
    (Object.keys(values) as Array<keyof AppearanceSettings>).some((key) => raw[key] !== values[key]);
  return { values, changed };
}

/** Returns a copy of `settings` with the migrated keys set and platform_theme removed. */
export function applyAppearanceMigration<T extends object>(settings: T, values: AppearanceSettings): Omit<T, typeof LEGACY_KEY> & AppearanceSettings {
  const rest: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  delete rest[LEGACY_KEY];
  return { ...rest, ...values } as Omit<T, typeof LEGACY_KEY> & AppearanceSettings;
}
