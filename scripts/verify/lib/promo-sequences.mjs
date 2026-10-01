// Promo frame sequences: real captures of the app in motion (search typing, the side bar sliding in and
// pinning, a command printing over time, Customize toggling Home sections, Home scrolling).
// Saved as <scene>-seq-<name>-<nnn>.png at the same size and scale as the stills.

import { clickSelector, clickText, invoke, pressKey, sleep, withTimeout } from './ui.mjs';
import { stepAnimations } from './promo-capture.mjs';
import { focusSessionTab, scrollHomeTop } from './promo-data.mjs';
import { expandFolders, prepareMain, showHome } from './promo-setup.mjs';
import { setSidebar, withStores } from './restyle-data.mjs';

const COMBOBOX = 'input[role=combobox]';
const CARD_TEXTS = ['Recently connected', 'Open now', 'Favorites', 'AI activity'];
const cards = CARD_TEXTS.map((t) => ({ label: t, text: t, card: true }));
const CUSTOMIZE_LABELS = '[aria-label="Customize Home"] label';
const QUERY = 'web-01';
const SCROLL_FRAMES = 12;
const SLIDE_FRAMES = 8;
const PIN_FRAME_DELAYS_MS = [0, 120, 300, 600, 1000];

async function searchTyping(d, rec) {
  const frame = (targets) => rec.frame(d, { scene: 's1', name: 'search', description: `Home search typing "${QUERY}", one frame per letter, then moving down the results`, targets });
  const bar = [{ label: 'Search bar', selector: COMBOBOX }, { label: 'Results', selector: '[role=listbox]' }];
  await scrollHomeTop(d);
  await withTimeout(d.page.evaluate((sel) => document.querySelector(sel)?.focus(), COMBOBOX), 10_000, 'focus search');
  await sleep(300);
  await frame(bar);
  for (const ch of QUERY) {
    await d.page.keyboard.type(ch, { delay: 20 });
    await sleep(350);
    await frame(bar);
  }
  await pressKey(d, 'ArrowDown');
  await sleep(150);
  await frame(bar);
  await pressKey(d, 'Escape');
  await sleep(300);
}

async function customizeToggle(d, rec) {
  const frame = (targets = null) => rec.frame(d, { scene: 's1', name: 'home-customize', description: 'Customize on Home: sections switched off and on again', targets });
  const toggle = async (label) => {
    await clickText(d, label, { exact: true, selector: CUSTOMIZE_LABELS });
    await sleep(450);
    await frame();
  };
  await scrollHomeTop(d);
  await sleep(300);
  await frame();
  await clickText(d, 'Customize', { exact: true, selector: 'button' });
  await sleep(450);
  await frame();
  await toggle('Favorites');
  await toggle('AI activity');
  await toggle('Open now');
  await toggle('Open now');
  await toggle('AI activity');
  await toggle('Favorites');
  await pressKey(d, 'Escape');
  await sleep(450);
  await frame(cards);
}

async function homeScroll(d, rec) {
  await scrollHomeTop(d);
  await sleep(300);
  const max = await d.page.evaluate(() => {
    const h1 = [...document.querySelectorAll('h1')].find((h) => h.textContent.startsWith('Welcome back') && h.getClientRects().length > 0);
    const scroller = h1?.closest('.overflow-y-auto');
    globalThis.__promoScroller = scroller;
    return scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
  });
  for (let i = 0; i < SCROLL_FRAMES; i++) {
    await d.page.evaluate(async (top) => {
      globalThis.__promoScroller.scrollTop = top;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, Math.round((max * i) / (SCROLL_FRAMES - 1)));
    await rec.frame(d, { scene: 's1', name: 'home-scroll', description: 'Home scrolled from the top to Vault status and Overview', targets: i === SCROLL_FRAMES - 1 ? cards : null });
  }
  await scrollHomeTop(d);
}

async function sidebarPin(d, rec) {
  const frame = (targets = null) => rec.frame(d, { scene: 's4', name: 'sidebar-pin', description: 'Side bar sliding in over the content, then pinned with its pin button', targets });
  await setSidebar(d, 'hidden');
  await sleep(500);
  await stepAnimations(d, () => withStores(d, (_, s) => {
    const sb = s.sidebar.getState();
    sb.setPinned(false);
    sb.expand();
    return true;
  }, null, { label: 'open the side bar floating' }), SLIDE_FRAMES, () => frame());
  await sleep(500);
  await frame([{ label: 'Pin button', selector: '[data-sidebar-panel] button[title^="Pin"]' }, { label: 'Side bar', selector: '[data-sidebar-panel]' }]);
  await clickSelector(d, '[data-sidebar-panel] button[title^="Pin"]');
  let waited = 0;
  for (const at of PIN_FRAME_DELAYS_MS) {
    await sleep(at - waited);
    waited = at;
    await frame();
  }
  await frame([{ label: 'Unpin button', selector: '[data-sidebar-panel] button[title^="Unpin"]' }, { label: 'Side bar', selector: '[data-sidebar-panel]' }]);
}

const SCRIPT_DEFINE = [
  "PROMPT='%F{green}ops@acme%f %F{blue}%~%f %# '",
  "deploy() { echo 'Deploying acme-api v2.4.1'; for s in build test push migrate restart; do printf '  %-9s' $s; sleep 0.6; printf '\\e[32mdone\\e[0m\\n'; done; echo 'Deployed 5 steps'; }",
  'clear',
];
const TERMINAL_FRAMES = 12;

async function terminalRun(d, rec) {
  const write = (text) => invoke(d, 'terminal_write', { sessionId: shell, data: [...Buffer.from(text)] });
  const frame = (targets = null) => rec.frame(d, { scene: 's5', name: 'terminal-run', description: 'A command typed in a terminal tab and printing output step by step', targets });
  const shell = await withStores(d, (_, s) => s.session.getState().createLocalShell(), null, { label: 'open a local shell' });
  await sleep(1500);
  for (const line of SCRIPT_DEFINE) {
    await write(`${line}\r`);
    await sleep(500);
  }
  await focusSessionTab(d, shell);
  await sleep(800);
  await frame([{ label: 'Terminal', selector: '.xterm' }]);
  for (const part of ['dep', 'loy']) {
    await write(part);
    await sleep(350);
    await frame();
  }
  await write('\r');
  for (let i = 0; i < TERMINAL_FRAMES; i++) await frame(i === TERMINAL_FRAMES - 1 ? [{ label: 'Terminal', selector: '.xterm' }] : null);
  await sleep(1500);
  await frame([{ label: 'Terminal', selector: '.xterm' }]);
}

async function seq(ctx, rec) {
  const { d } = await prepareMain(ctx, 'pq', 'dark', { sidebar: 'hidden' });
  await showHome(d);
  await searchTyping(d, rec);
  await customizeToggle(d, rec);
  await homeScroll(d, rec);
  await sidebarPin(d, rec);
  await expandFolders(d);
  await terminalRun(d, rec);
  await ctx.quitDevice(d);
}

export const SEQ_SCENES = { seq };
