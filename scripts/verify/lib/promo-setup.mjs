// Shared setup of the promo scenes: a local-mode device with the filled demo vault, live SSH tabs and
// the Home dashboard fed by fake handlers.

import { createVault, enterLocalMode, waitForScreen } from './flows.mjs';
import { launchPromoDevice } from './promo-capture.mjs';
import { attentionState, fillPromo, focusSessionTab, homeFixtures, installFakeHandlers, openMockSsh } from './promo-data.mjs';
import { expandFolderInPage, selectEntry, setSidebar, vaultPath, withStores, ACME, VAULT_PASSWORD } from './restyle-data.mjs';
import { SELECTORS } from './selectors.mjs';
import { mainEval, sleep, waitFor, waitForText, withTimeout } from './ui.mjs';

export const HOME_ID = '__home__';
const FOLDER_CHILD = [['Production', 'web-01'], ['Databases', 'db-01'], ['Staging', 'Build Mac']];

/** Opens Production, Databases and Staging in the side bar tree (the side bar must be open). */
export async function expandFolders(device) {
  for (const [folder, child] of FOLDER_CHILD) {
    await waitFor(async () => {
      const res = await withTimeout(device.page.evaluate(expandFolderInPage, { folder, child, twistie: SELECTORS.treeTwistie.hook }), 10_000, `${device.name}: expand ${folder}`);
      if (res === 'expanded') return true;
      if (res !== 'clicked') throw new Error(res);
      return false;
    }, { timeoutMs: 10_000, intervalMs: 300, label: `${device.name}: folder ${folder} expanded` });
  }
}

/**
 * Launches `name` in `mode` and fills the demo vault. `ssh` lists the entry keys to open as live tabs
 * (in that order); the first one ends up active. Returns {d, ids, sessions}.
 */
export async function prepareMain(ctx, name, mode, { ssh = ['web', 'db', 'api'], sidebar = 'docked' } = {}) {
  const d = await launchPromoDevice(ctx, name, mode);
  await installFakeHandlers(d, mainEval);
  await enterLocalMode(d);
  await createVault(d, vaultPath(d, ACME), VAULT_PASSWORD);
  await waitForScreen(d, 'main');
  const { ids } = await fillPromo(d);
  const sessions = {};
  for (const key of ssh) sessions[key] = await openMockSsh(ctx.run, d, { ids, key });
  await mainEval(d, (_, f) => {
    globalThis.__homeFixtures = f;
    return true;
  }, homeFixtures(ids), { label: 'set dashboard fixtures' });
  await attentionState(d);
  await setSidebar(d, sidebar === 'hidden' ? 'floating' : sidebar);
  if (sidebar !== 'hidden') await expandFolders(d);
  if (ssh[0]) {
    await focusSessionTab(d, sessions[ssh[0]]);
    await selectEntry(d, ids[ssh[0]]);
  }
  if (sidebar === 'hidden') await setSidebar(d, 'hidden');
  return { d, ids, sessions };
}

/** Closes and reopens the Home tab so every card loads the fixtures, then waits for the cards. */
export async function showHome(d, { passwords = true } = {}) {
  await withStores(d, (id, s) => {
    s.session.getState().removeSession(id);
    return true;
  }, HOME_ID, { label: 'close Home' });
  await sleep(200);
  await focusSessionTab(d, HOME_ID);
  // Recently connected reloads only when the session ids or the history version change.
  await withTimeout(d.page.evaluate(async () => {
    const { bumpHistoryVersion } = await import('/src/components/dashboard/home/homeFeeds.ts');
    bumpHistoryVersion();
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  }), 10_000, `${d.name}: reload Home feeds`);
  await waitForText(d, 'Recently connected', { timeoutMs: 15_000 });
  await waitForText(d, 'Recent tool calls from AI agents on this device', { timeoutMs: 15_000 });
  if (passwords) await waitForText(d, 'passwords older than', { timeoutMs: 15_000 });
  await sleep(600);
}
