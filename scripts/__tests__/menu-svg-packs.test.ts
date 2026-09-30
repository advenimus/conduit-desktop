// Every icon of every pack, as iconToSvg hands it to the popup menu, passes the main-process sanitizer
// (spec 5.7, 7.1). Lives under scripts because it imports from both src and electron (spec 8.1).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ICON_PACK,
  ICON_PACKS,
  SEMANTIC_ICON_NAMES,
  iconToSvg,
  preloadAllIconPacks,
  setIconPack,
  type IconPackId,
} from '../../src/lib/icons';
import { sanitizeSvg } from '../../electron/ipc/menu-svg';

// src/utils/contextMenu.ts renders menu icons at 16px.
const MENU_ICON_SIZE = 16;
// The first import of the five lazy packs takes a few seconds alone and more in a loaded full run.
const PRELOAD_TIMEOUT_MS = 30_000;
const PACK_IDS: readonly IconPackId[] = ['lucide', 'phosphor', 'hugeicons', 'material', 'fluent', 'tabler'];

const withoutDroppedAttributes = (svg: string) => svg.replace(/ (?:aria-hidden|focusable)="[^"]*"/g, '');

beforeAll(() => preloadAllIconPacks(), PRELOAD_TIMEOUT_MS);

afterAll(() => setIconPack(DEFAULT_ICON_PACK));

it('covers the six packs and all 118 semantic names', () => {
  expect(ICON_PACKS.map((pack) => pack.id)).toEqual(PACK_IDS);
  expect(SEMANTIC_ICON_NAMES).toHaveLength(118);
});

describe.each(PACK_IDS)('the %s pack in the popup menu', (id) => {
  it('keeps every icon whole through sanitizeSvg, dropping only aria-hidden and focusable', async () => {
    await setIconPack(id);
    for (const name of SEMANTIC_ICON_NAMES) {
      const svg = iconToSvg(name, MENU_ICON_SIZE);
      expect(svg, `${id}:${name}`).toMatch(/ aria-hidden="true"/);
      expect(sanitizeSvg(svg), `${id}:${name}`).toBe(withoutDroppedAttributes(svg));
    }
  });

  it('draws a different Edit icon than the other packs', async () => {
    await setIconPack(id);
    const mine = iconToSvg('pencil', MENU_ICON_SIZE);
    for (const other of PACK_IDS.filter((p) => p !== id)) {
      await setIconPack(other);
      expect(iconToSvg('pencil', MENU_ICON_SIZE), `${id} vs ${other}`).not.toBe(mine);
    }
  });
});
