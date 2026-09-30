// @vitest-environment node
// The window background palette of the main process (spec 7.2) against the renderer's shell colors. Lives here
// because it reads from both trees.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_PALETTE, paletteMode, windowBackground } from '../../electron/services/appearance-palette';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shellColors = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/appearance/shell-colors.json'), 'utf8')) as Record<
  string,
  Record<'dark' | 'light', { shell: string; fg: string }>
>;
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/lib/appearance/migration-table.json'), 'utf8')) as { schemes: string[] };

describe('appearance palette parity (spec 7.2)', () => {
  it('holds exactly the shell color of every scheme and mode in shell-colors.json', () => {
    const expected = Object.fromEntries(
      Object.entries(shellColors).map(([scheme, modes]) => [scheme, { dark: modes.dark.shell, light: modes.light.shell }]),
    );
    expect(SHELL_PALETTE).toEqual(expected);
  });

  it('covers every scheme the migration accepts', () => {
    expect(Object.keys(SHELL_PALETTE).sort()).toEqual([...table.schemes].sort());
  });
});

describe('windowBackground', () => {
  it('picks the saved scheme and mode', () => {
    expect(windowBackground({ color_scheme: 'ocean', theme: 'dark' }, false)).toBe(SHELL_PALETTE.ocean.dark);
    expect(windowBackground({ color_scheme: 'ember', theme: 'light' }, true)).toBe(SHELL_PALETTE.ember.light);
  });

  it('follows the OS for the system theme', () => {
    expect(windowBackground({ color_scheme: 'modern', theme: 'system' }, true)).toBe('#191A1B');
    expect(windowBackground({ color_scheme: 'modern', theme: 'system' }, false)).toBe('#FAFAFD');
    expect(paletteMode(undefined, true)).toBe('dark');
    expect(paletteMode('bogus', false)).toBe('light');
  });

  it('falls back to Modern for an unknown or missing scheme, and never to the old navy', () => {
    expect(windowBackground({ color_scheme: 'macos-blue', theme: 'dark' }, false)).toBe(SHELL_PALETTE.modern.dark);
    expect(windowBackground({ color_scheme: 'toString', theme: 'dark' }, false)).toBe(SHELL_PALETTE.modern.dark);
    expect(windowBackground(null, true)).toBe(SHELL_PALETTE.modern.dark);
    expect(windowBackground(undefined, false)).toBe(SHELL_PALETTE.modern.light);
    for (const modes of Object.values(SHELL_PALETTE)) expect(Object.values(modes)).not.toContain('#0f172a');
  });
});
