// The scenes of the promo footage (docs: STORYBOARD of the 0.18 promo). Each takes (ctx, recorder).

import { pressKey, sleep, waitFor, withTimeout } from './ui.mjs';
import { scrollHomeTop } from './promo-data.mjs';
import { expandFolders, prepareMain, showHome } from './promo-setup.mjs';
import { setSidebar } from './restyle-data.mjs';
import { setLook } from './promo-capture.mjs';
import { openSettings, cancelSettings } from './settings-flows.mjs';
import { MORE_SCENES } from './promo-scenes-more.mjs';
import { SYNC_SCENES } from './promo-scenes-sync.mjs';
import { SEQ_SCENES } from './promo-sequences.mjs';
import { FILM_SCENES } from './promo-scenes-film.mjs';
import { KB_SCENES } from './promo-scenes-kb.mjs';

const COMBOBOX = 'input[role=combobox]';
const CARDS = ['Recently connected', 'Open now', 'Favorites', 'AI activity'];
const cardTargets = CARDS.map((t) => ({ label: t, text: t, card: true }));

async function s1(ctx, rec) {
  const { d } = await prepareMain(ctx, 'p1', 'dark', { sidebar: 'hidden' });
  await showHome(d);
  await scrollHomeTop(d);
  await rec.shot(d, { scene: 's1', name: 'home-full', description: 'Home dashboard with every card filled', targets: [...cardTargets, { label: 'Needs attention', selector: '[data-attention]' }] });
  await setSidebar(d, 'docked');
  await expandFolders(d);
  await scrollHomeTop(d);
  await rec.shot(d, { scene: 's1', name: 'home-sidebar', description: 'Home with the side bar docked', targets: [{ label: 'Side bar', selector: '[data-sidebar-panel]' }, ...cardTargets.slice(0, 2)] });
  await setSidebar(d, 'hidden');
  await d.page.evaluate(() => {
    const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent.startsWith('Welcome back') && h.getClientRects().length > 0);
    const scroller = h1?.closest('.overflow-y-auto');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await rec.shot(d, { scene: 's1', name: 'home-bottom', description: 'Home scrolled to Vault status and Overview', targets: [{ label: 'Vault status', text: 'Vault status', card: true }, { label: 'Overview', text: 'Overview', card: true }] });
  await scrollHomeTop(d);

  await withTimeout(d.page.evaluate((sel) => document.querySelector(sel)?.focus(), COMBOBOX), 10_000, 'focus search');
  let typed = '';
  for (const ch of 'web-0') {
    await d.page.keyboard.type(ch, { delay: 30 });
    typed += ch;
    await rec.shot(d, { scene: 's1', name: `search-typing-${typed.replace('-', 'dash')}`, description: `Search bar with "${typed}" typed`, targets: [{ label: 'Search bar', selector: COMBOBOX }], settleMs: 450 });
  }
  await waitFor(async () => (await d.page.evaluate(() => document.querySelectorAll('[role=option]').length)) > 1, { timeoutMs: 10_000, label: 'search results' });
  await pressKey(d, 'ArrowDown');
  await rec.shot(d, { scene: 's1', name: 'search-results', description: 'Search results for "web-0" with the second row active', targets: [{ label: 'Search bar', selector: COMBOBOX }, { label: 'Results', selector: '[role=listbox]' }] });
  await pressKey(d, 'Escape');
  await ctx.quitDevice(d);
}

const PACKS = ['lucide', 'phosphor', 'hugeicons', 'material', 'fluent', 'tabler'];
const MAIN_TARGETS = [{ label: 'Side bar', selector: '[data-sidebar-panel]' }, { label: 'Tab bar', selector: '[data-tabbar]' }];

async function s3(ctx, rec) {
  const { d } = await prepareMain(ctx, 'p3', 'dark');
  for (const pack of PACKS) {
    await setLook(d, { iconPack: pack });
    await rec.shot(d, { scene: 's3', name: `look-${pack}`, description: `The main screen with the ${pack} icon pack (dark)`, targets: MAIN_TARGETS, settleMs: 700 });
  }
  await setLook(d, { iconPack: 'lucide' });
  await openSettings(d, 'appearance');
  await sleep(700);
  await rec.shot(d, { scene: 's3', name: 'settings-appearance', description: 'Settings > Appearance with the icon pack picker (dark)', targets: [{ label: 'Icon pack picker', selector: '[data-cv-appearance="icon-pack"]' }, { label: 'Color scheme', selector: '[data-cv-appearance="scheme"]' }] });
  await cancelSettings(d);
  await setLook(d, { theme: 'light' });
  await rec.shot(d, { scene: 's3', name: 'look-light', description: 'The same main screen in light mode (lucide)', targets: MAIN_TARGETS, settleMs: 700 });
  await ctx.quitDevice(d);
}

async function s4(ctx, rec) {
  const { d } = await prepareMain(ctx, 'p4', 'dark', { ssh: ['web', 'db', 'api', 'redis'] });
  await rec.shot(d, { scene: 's4', name: 'sidebar-pinned', description: 'Side bar pinned beside the content', targets: [{ label: 'Side bar', selector: '[data-sidebar-panel]' }, { label: 'Pin button', selector: '[data-sidebar-panel] button[title^="Unpin"]' }] });
  await setSidebar(d, 'floating');
  await rec.shot(d, { scene: 's4', name: 'sidebar-floating', description: 'Side bar floating over the content', targets: [{ label: 'Side bar', selector: '[data-sidebar-panel]' }] });
  await setSidebar(d, 'hidden');
  await rec.shot(d, { scene: 's4', name: 'sidebar-hidden', description: 'Side bar hidden, content full width', targets: [{ label: 'Tab bar', selector: '[data-tabbar]' }] });
  await rec.shot(d, { scene: 's4', name: 'pill-tabs', description: 'Pill tabs with four open sessions', targets: [{ label: 'Tab bar', selector: '[data-tabbar]' }], crop: { label: 'Tab bar', pad: 16 } });
  await ctx.quitDevice(d);
}

export const SCENES = { s1, s3, s4, ...MORE_SCENES, ...SYNC_SCENES, ...SEQ_SCENES, ...FILM_SCENES, ...KB_SCENES };
