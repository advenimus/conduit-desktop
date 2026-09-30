/**
 * Main-process side of the appearance migration (docs/VISUAL_REDESIGN.md 6.3): retired platform themes
 * and native schemes move to the universal schemes and an icon pack, and the retired keys are deleted.
 * The renderer runs the same rules before first paint (src/lib/appearance); tests keep the table and the
 * behavior equal on both sides. Electron code never imports from src/, so the table is repeated here.
 */

export const APPEARANCE_MIGRATION_TABLE = {
  version: 2,
  schemes: ['modern', 'ocean', 'ember', 'forest', 'amethyst', 'rose', 'midnight'],
  iconPacks: ['lucide', 'phosphor', 'hugeicons', 'material', 'fluent', 'tabler'],
  themes: ['dark', 'light', 'system'],
  defaults: {
    color_scheme: 'modern',
    icon_pack: 'lucide',
    theme: 'system',
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
  retiredKeys: ['platform_theme', 'ui_density', 'title_bar_style'],
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

type RetiredKey = (typeof TABLE.retiredKeys)[number];

export interface AppearanceSettings {
  appearance_version: number;
  color_scheme: string;
  icon_pack: string;
  theme: string;
}

export interface AppearanceMigration {
  values: AppearanceSettings;
  /** True when the stored file differs from `values` or still holds a retired key. */
  changed: boolean;
}

type RawSettings = Record<string, unknown>;

function isRecord(value: unknown): value is RawSettings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function pick(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function lookup(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return hasOwn(map, key) ? map[key] : undefined;
}

/** max(2, the stored integer): a higher version was written by a later build and is never written back as 2. */
function keptVersion(value: unknown): number {
  const stored = Number(value);
  return Number.isInteger(stored) && stored > TABLE.version ? stored : TABLE.version;
}

function retiredOr(scheme: unknown): unknown {
  return typeof scheme === 'string' ? (lookup(TABLE.retiredSchemes, scheme) ?? scheme) : scheme;
}

/** Runs on the parsed settings file before defaults are spread over it, so every rule sees raw values. */
export function migrateAppearance(input: unknown): AppearanceMigration {
  const raw = isRecord(input) ? input : {};
  const d = TABLE.defaults;

  let color_scheme: string;
  let icon_pack: string;
  if (Number(raw.appearance_version) >= TABLE.version) {
    color_scheme = pick(retiredOr(raw.color_scheme), TABLE.schemes, d.color_scheme);
    icon_pack = pick(raw.icon_pack, TABLE.iconPacks, d.icon_pack);
  } else {
    const platform = typeof raw.platform_theme === 'string' ? raw.platform_theme : TABLE.legacy.platform_theme;
    const scheme = typeof raw.color_scheme === 'string' ? raw.color_scheme : TABLE.legacy.color_scheme;
    const untouchedDefault = platform === TABLE.legacy.platform_theme && scheme === TABLE.legacy.color_scheme;
    color_scheme = pick(lookup(TABLE.retiredSchemes, scheme) ?? (untouchedDefault ? d.color_scheme : scheme), TABLE.schemes, d.color_scheme);
    icon_pack = pick(raw.icon_pack, TABLE.iconPacks, lookup(TABLE.packByPlatform, platform) ?? d.icon_pack);
  }

  const values: AppearanceSettings = {
    appearance_version: keptVersion(raw.appearance_version),
    color_scheme,
    icon_pack,
    theme: pick(raw.theme, TABLE.themes, d.theme),
  };
  const changed =
    TABLE.retiredKeys.some((key) => hasOwn(raw, key)) ||
    (Object.keys(values) as Array<keyof AppearanceSettings>).some((key) => raw[key] !== values[key]);
  return { values, changed };
}

/** Returns a copy of `settings` with the migrated keys set and every retired key removed. */
export function applyAppearanceMigration<T extends object>(settings: T, values: AppearanceSettings): Omit<T, RetiredKey> & AppearanceSettings {
  const rest: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const key of TABLE.retiredKeys) delete rest[key];
  return { ...rest, ...values } as Omit<T, RetiredKey> & AppearanceSettings;
}
