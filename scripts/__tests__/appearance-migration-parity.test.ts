// Behavior parity of the three appearance migrations (spec 6.3): boot-inline.js, src/lib/appearance/migrate.ts
// and electron/services/appearance-migration.ts. Lives here because it imports from both trees (spec 2.5).
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { loadBootScript } from '../../src/lib/appearance/bootScript.mjs';
import { migrateAppearanceStorage } from '../../src/lib/appearance/migrate';
import { applyAppearanceMigration, migrateAppearance as migrateMain } from '../../electron/services/appearance-migration';

interface Seed {
  version: string | null;
  platform: string | null;
  scheme: string | null;
  pack: string | null;
  theme: string | null;
  density: string | null;
}

const STORAGE_KEYS: Record<keyof Seed, string> = {
  version: 'conduit-appearance-version',
  platform: 'conduit-platform-theme',
  scheme: 'conduit-color-scheme',
  pack: 'conduit-icon-pack',
  theme: 'conduit-theme',
  density: 'conduit-density',
};

const bootScript = loadBootScript();

function seedStorage(seed: Seed): void {
  localStorage.clear();
  for (const [field, key] of Object.entries(STORAGE_KEYS)) {
    const value = seed[field as keyof Seed];
    if (value !== null) localStorage.setItem(key, value);
  }
}

function fromStorage() {
  return {
    appearance_version: Number(localStorage.getItem(STORAGE_KEYS.version)),
    color_scheme: localStorage.getItem(STORAGE_KEYS.scheme),
    icon_pack: localStorage.getItem(STORAGE_KEYS.pack),
    theme: localStorage.getItem(STORAGE_KEYS.theme),
    retiredRemoved: localStorage.getItem(STORAGE_KEYS.platform) === null && localStorage.getItem(STORAGE_KEYS.density) === null,
  };
}

function runAll(seed: Seed) {
  seedStorage(seed);
  new Function(bootScript)();
  const boot = fromStorage();

  seedStorage(seed);
  const renderer = migrateAppearanceStorage(localStorage);
  const rendererStored = fromStorage();

  const rawFile = {
    appearance_version: seed.version ?? undefined,
    platform_theme: seed.platform ?? undefined,
    color_scheme: seed.scheme ?? undefined,
    icon_pack: seed.pack ?? undefined,
    theme: seed.theme ?? undefined,
    ui_density: seed.density ?? undefined,
  };
  const { values } = migrateMain(rawFile);
  const file = applyAppearanceMigration(rawFile, values);
  const main = {
    appearance_version: values.appearance_version,
    color_scheme: values.color_scheme,
    icon_pack: values.icon_pack,
    theme: values.theme,
    retiredRemoved: !('platform_theme' in file) && !('ui_density' in file) && !('title_bar_style' in file),
  };
  return { boot, renderer: { ...renderer, retiredRemoved: rendererStored.retiredRemoved }, rendererStored, main };
}

const value = (...known: string[]) => fc.option(fc.oneof(fc.constantFrom(...known), fc.string({ maxLength: 12 })), { nil: null });

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

describe('appearance migration parity: boot-inline.js, migrate.ts and the main process', () => {
  it('agree on every spec 6.3 row', () => {
    const rows: Seed[] = [
      { version: null, platform: 'default', scheme: 'ocean', pack: null, theme: null, density: null },
      { version: null, platform: null, scheme: null, pack: null, theme: null, density: null },
      { version: null, platform: 'macos', scheme: 'macos-blue', pack: null, theme: 'dark', density: null },
      { version: null, platform: 'windows', scheme: 'win-sun-valley', pack: null, theme: null, density: 'compact' },
      { version: null, platform: 'ubuntu', scheme: 'ubuntu-yaru', pack: null, theme: 'light', density: null },
      { version: null, platform: 'ubuntu', scheme: 'ubuntu-gnome', pack: null, theme: null, density: null },
      { version: null, platform: 'macos', scheme: 'ocean', pack: null, theme: null, density: null },
      { version: null, platform: 'windows', scheme: 'macos-graphite', pack: null, theme: null, density: null },
      { version: '2', platform: 'macos', scheme: 'rose', pack: 'material', theme: 'system', density: 'compact' },
      { version: '2', platform: null, scheme: 'rose', pack: 'codicons', theme: null, density: 'compact' },
      { version: '2', platform: null, scheme: 'ubuntu-yaru', pack: 'hugeicons', theme: null, density: null },
      { version: null, platform: 'macos', scheme: 'ocean', pack: null, theme: 'bogus', density: null },
      { version: '2', platform: null, scheme: 'ember', pack: 'fluent', theme: 'bogus', density: null },
      { version: '3', platform: null, scheme: 'ember', pack: 'lucide', theme: 'dark', density: 'compact' },
    ];
    for (const seed of rows) {
      const { boot, renderer, main } = runAll(seed);
      expect(boot, JSON.stringify(seed)).toEqual(main);
      expect(renderer, JSON.stringify(seed)).toEqual(main);
    }
  });

  it('agree on random inputs', () => {
    fc.assert(
      fc.property(
        fc.record({
          version: value('2', '1', '3', '7', '2.5', '0', 'two'),
          platform: value('default', 'macos', 'windows', 'ubuntu', '__proto__', 'constructor'),
          scheme: value('ocean', 'modern', 'ember', 'forest', 'amethyst', 'rose', 'midnight', 'macos-blue', 'macos-graphite', 'win-blue', 'win-sun-valley', 'ubuntu-yaru', 'ubuntu-gnome', 'toString'),
          pack: value('codicons', 'lucide', 'phosphor', 'hugeicons', 'material', 'fluent', 'tabler'),
          theme: value('dark', 'light', 'system', 'sepia'),
          density: value('comfortable', 'compact'),
        }),
        (seed) => {
          const { boot, renderer, main } = runAll(seed);
          expect(boot).toEqual(main);
          expect(renderer).toEqual(main);
        },
      ),
      { numRuns: 300 },
    );
  });
});
