// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPEARANCE_MIGRATION_TABLE, applyAppearanceMigration, migrateAppearance } from '../appearance-migration.js';

const dataDir = vi.hoisted(() => ({ current: '' }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/conduit-appearance-test', relaunch: vi.fn(), quit: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../state.js', () => ({ AppState: { getInstance: vi.fn() } }));
vi.mock('../local-network.js', () => ({ getLocalNetworkStatus: vi.fn() }));
vi.mock('../env-config.js', () => ({ getDataDir: () => dataDir.current }));

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('migrateAppearance (main process, spec 6.3)', () => {
  const rows: Array<[string, Record<string, unknown>, string, string]> = [
    ['untouched default', { platform_theme: 'default', color_scheme: 'ocean' }, 'modern', 'codicons'],
    ['no appearance keys', {}, 'modern', 'codicons'],
    ['default + ember', { platform_theme: 'default', color_scheme: 'ember' }, 'ember', 'codicons'],
    ['macos + macos-blue', { platform_theme: 'macos', color_scheme: 'macos-blue' }, 'modern', 'phosphor'],
    ['macos + macos-graphite', { platform_theme: 'macos', color_scheme: 'macos-graphite' }, 'modern', 'phosphor'],
    ['windows + win-blue', { platform_theme: 'windows', color_scheme: 'win-blue' }, 'modern', 'fluent'],
    ['windows + win-sun-valley', { platform_theme: 'windows', color_scheme: 'win-sun-valley' }, 'modern', 'fluent'],
    ['ubuntu + ubuntu-yaru', { platform_theme: 'ubuntu', color_scheme: 'ubuntu-yaru' }, 'ember', 'tabler'],
    ['ubuntu + ubuntu-gnome', { platform_theme: 'ubuntu', color_scheme: 'ubuntu-gnome' }, 'modern', 'tabler'],
    ['macos keeps ocean', { platform_theme: 'macos', color_scheme: 'ocean' }, 'ocean', 'phosphor'],
    ['ubuntu keeps rose', { platform_theme: 'ubuntu', color_scheme: 'rose' }, 'rose', 'tabler'],
    ['windows + a stale macOS scheme', { platform_theme: 'windows', color_scheme: 'macos-blue' }, 'modern', 'fluent'],
    ['null platform counts as default', { platform_theme: null, color_scheme: 'ocean' }, 'modern', 'codicons'],
  ];

  it.each(rows)('%s', (_label, raw, scheme, pack) => {
    const { values, changed } = migrateAppearance(raw);
    expect(values).toEqual({ appearance_version: 2, color_scheme: scheme, icon_pack: pack, ui_density: 'comfortable', title_bar_style: 'custom' });
    expect(changed).toBe(true);
  });

  it('reads the raw values: a legacy file migrates even though the defaults hold appearance_version 2', () => {
    const merged = { appearance_version: 2, color_scheme: 'modern', icon_pack: 'codicons', platform_theme: 'macos' };
    const raw = { platform_theme: 'macos', color_scheme: 'macos-graphite' };
    expect(migrateAppearance(raw).values.icon_pack).toBe('phosphor');
    expect(migrateAppearance(merged).values.icon_pack).toBe('codicons');
  });

  it('version 2 validates only and reports no change when everything is valid', () => {
    const raw = { appearance_version: 2, color_scheme: 'ocean', icon_pack: 'tabler', ui_density: 'compact', title_bar_style: 'native' };
    expect(migrateAppearance(raw)).toEqual({ values: raw, changed: false });
    expect(migrateAppearance({ ...raw, color_scheme: 'win-blue', title_bar_style: 'frameless' }).values).toMatchObject({ color_scheme: 'modern', title_bar_style: 'custom' });
    expect(migrateAppearance({ ...raw, platform_theme: 'macos' }).changed).toBe(true);
  });

  it('non-object input is treated as an empty file', () => {
    expect(migrateAppearance(null).values.color_scheme).toBe('modern');
    expect(migrateAppearance([1, 2]).values.color_scheme).toBe('modern');
  });

  it('is idempotent and a migrated result needs no second write', () => {
    const text = fc.option(fc.oneof(fc.constantFrom('default', 'macos', 'windows', 'ubuntu', 'ocean', 'modern', 'ember', 'win-blue', 'ubuntu-yaru', 'lucide', 'compact', 'native'), fc.string()), { nil: undefined });
    const version = fc.option(fc.oneof(fc.integer({ min: 0, max: 3 }), fc.constantFrom('2', '1', 'x')), { nil: undefined });
    fc.assert(
      fc.property(
        fc.record({ appearance_version: version, platform_theme: text, color_scheme: text, icon_pack: text, ui_density: text, title_bar_style: text }, { requiredKeys: [] }),
        (raw) => {
          const once = migrateAppearance(raw);
          const file = applyAppearanceMigration(raw, once.values);
          const twice = migrateAppearance(file);
          expect(twice.values).toEqual(once.values);
          expect(twice.changed).toBe(false);
        },
      ),
    );
  });

  it('applyAppearanceMigration sets the keys, drops platform_theme and keeps the rest, without mutating', () => {
    const settings = { theme: 'dark', platform_theme: 'macos', color_scheme: 'macos-blue', recent_vaults: ['/a'] };
    const next = applyAppearanceMigration(settings, migrateAppearance(settings).values);
    expect(next).toEqual({ theme: 'dark', color_scheme: 'modern', icon_pack: 'phosphor', ui_density: 'comfortable', title_bar_style: 'custom', appearance_version: 2, recent_vaults: ['/a'] });
    expect(settings.platform_theme).toBe('macos');
  });

  it('the table equals src/lib/appearance/migration-table.json (read with fs)', () => {
    const json = JSON.parse(fs.readFileSync(path.join(REPO, 'src', 'lib', 'appearance', 'migration-table.json'), 'utf8'));
    expect(APPEARANCE_MIGRATION_TABLE).toEqual(json);
  });
});

describe('readSettings() runs the migration on the raw file (temp data dir)', () => {
  let writes: MockInstance<typeof fs.writeFileSync>;

  beforeEach(() => {
    dataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-appearance-'));
    vi.resetModules();
    writes = vi.spyOn(fs, 'writeFileSync');
  });

  afterEach(() => {
    writes.mockRestore();
    fs.rmSync(dataDir.current, { recursive: true, force: true });
  });

  async function readTwice(file: Record<string, unknown>) {
    const settingsFile = path.join(dataDir.current, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(file));
    writes.mockClear();
    const { readSettings } = await import('../../ipc/settings.js');
    const first = readSettings();
    const writesAfterFirst = writes.mock.calls.filter((c) => c[0] === settingsFile).length;
    const second = readSettings();
    const writesAfterSecond = writes.mock.calls.filter((c) => c[0] === settingsFile).length;
    const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return { first, second, writesAfterFirst, writesAfterSecond, onDisk };
  }

  it('macos + macos-blue: Modern with Phosphor, one write-back, none on the second read', async () => {
    const r = await readTwice({ theme: 'dark', platform_theme: 'macos', color_scheme: 'macos-blue', recent_vaults: ['/v/a.conduit'] });
    expect(r.first).toMatchObject({ color_scheme: 'modern', icon_pack: 'phosphor', ui_density: 'comfortable', title_bar_style: 'custom', appearance_version: 2, theme: 'dark' });
    expect(r.first).not.toHaveProperty('platform_theme');
    expect(r.writesAfterFirst).toBe(1);
    expect(r.writesAfterSecond).toBe(1);
    expect(r.second).toEqual(r.first);
    expect(r.onDisk).toEqual({ theme: 'dark', recent_vaults: ['/v/a.conduit'], color_scheme: 'modern', icon_pack: 'phosphor', ui_density: 'comfortable', title_bar_style: 'custom', appearance_version: 2 });
  });

  it('default + ocean moves to Modern with Codicons', async () => {
    const r = await readTwice({ platform_theme: 'default', color_scheme: 'ocean' });
    expect(r.first).toMatchObject({ color_scheme: 'modern', icon_pack: 'codicons', appearance_version: 2 });
    expect(r.writesAfterFirst).toBe(1);
    expect(r.writesAfterSecond).toBe(1);
    expect(r.onDisk).not.toHaveProperty('platform_theme');
  });

  it('a file with no appearance keys gets the defaults written once', async () => {
    const r = await readTwice({ onboarding_completed: true, last_vault_path: null });
    expect(r.first).toMatchObject({ color_scheme: 'modern', icon_pack: 'codicons', ui_density: 'comfortable', title_bar_style: 'custom', appearance_version: 2 });
    expect(r.writesAfterFirst).toBe(1);
    expect(r.writesAfterSecond).toBe(1);
    expect(r.onDisk).toMatchObject({ onboarding_completed: true, last_vault_path: null, color_scheme: 'modern' });
  });

  it('an already migrated file is never rewritten', async () => {
    const r = await readTwice({ color_scheme: 'rose', icon_pack: 'lucide', ui_density: 'compact', title_bar_style: 'native', appearance_version: 2 });
    expect(r.first).toMatchObject({ color_scheme: 'rose', icon_pack: 'lucide', ui_density: 'compact', title_bar_style: 'native' });
    expect(r.writesAfterSecond).toBe(0);
  });

  it('no settings file: the defaults, and nothing is written', async () => {
    const { readSettings } = await import('../../ipc/settings.js');
    writes.mockClear();
    expect(readSettings()).toMatchObject({ color_scheme: 'modern', icon_pack: 'codicons', ui_density: 'comfortable', title_bar_style: 'custom', appearance_version: 2 });
    expect(writes).not.toHaveBeenCalled();
  });

  it('a failed write-back is logged and the migrated values are still returned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const settingsFile = path.join(dataDir.current, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ platform_theme: 'windows', color_scheme: 'win-blue' }));
    writes.mockImplementation(() => {
      throw new Error('read-only');
    });
    const { readSettings } = await import('../../ipc/settings.js');
    expect(readSettings()).toMatchObject({ color_scheme: 'modern', icon_pack: 'fluent' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
