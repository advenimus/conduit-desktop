// Drives the knowledge base and secret chip screens like a user and checks the results.
// Run from the repo root: node scripts/verify/capture-knowledge-interact.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers } from './lib/run-context.mjs';
import { launchInMode } from './lib/restyle-flows.mjs';
import { createVault, enterLocalMode, refreshEntries, waitForScreen } from './lib/flows.mjs';
import { clickInTopDialog, setSidebar, vaultPath, withStores } from './lib/restyle-data.mjs';
import { captureWindow } from './lib/window-capture.mjs';
import { clickSelector, clickText, invoke, mainEval, sleep, typeInto, waitFor, waitForText } from './lib/ui.mjs';

const OUT = path.resolve(process.argv[2] ?? '.verify/knowledge/interact');
const log = (m) => console.log(`[kb] ${m}`);
const results = [];
let seq = 0;
async function shot(d, name) {
  seq += 1;
  await sleep(400);
  await captureWindow(d, path.join(OUT, `${String(seq).padStart(2, '0')}-${name}.png`), { method: 'page' });
}
function check(ok, what) {
  results.push({ ok: !!ok, what });
  log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
}
const REF_RE = /\{\{secret:([0-9a-f-]{36})(?:\|[^}]*)?\}\}/;
const open = (d, fn, arg, label) => withStores(d, fn, arg, { label });
const clickVisible = (d, selector, text) => d.page.evaluate(({ selector, text }) => {
  const el = [...document.querySelectorAll(selector)].find((b) => b.getClientRects().length > 0 && (!text || (b.innerText ?? '').trim() === text));
  if (!el) return false;
  el.click();
  return true;
}, { selector, text });

async function flow(ctx, d) {
  await enterLocalMode(d);
  await createVault(d, vaultPath(d, 'Acme'), 'kb-interact-pw-1');
  await waitForScreen(d, 'main');
  const web = await invoke(d, 'entry_create', { name: 'ui-web-01', entry_type: 'ssh', host: '10.5.0.1', port: 22, username: 'deploy' });
  const db = await invoke(d, 'entry_create', { name: 'ui-db-01', entry_type: 'ssh', host: '10.5.0.2', port: 22, notes: 'Primary.\n## Backups\nNightly dump\n## Failover\n1. Promote replica' });
  await refreshEntries(d);
  await setSidebar(d, 'docked');

  // 1. Add an encrypted secret from the notes editor, then save.
  await d.page.evaluate((id) => document.dispatchEvent(new CustomEvent('conduit:edit-entry', { detail: id })), web.id);
  await waitFor(() => clickVisible(d, '[data-dialog-content] button', 'Information'), { timeoutMs: 15_000, label: 'Information tab' });
  await sleep(300);
  const NOTES = 'textarea[placeholder^="Optional notes"]';
  await typeInto(d, NOTES, 'Local admin: ');
  await clickSelector(d, '[aria-label="Add encrypted secret"]');
  await typeInto(d, 'input[placeholder="Local admin"]', 'Local admin');
  await typeInto(d, 'input[placeholder="Leave empty to generate"]', 'ui-typed-secret-1');
  await clickText(d, 'Add', { exact: true, selector: 'button' });
  await sleep(500);
  const draft = await d.page.evaluate((sel) => document.querySelector(sel)?.value ?? '', NOTES);
  check(REF_RE.test(draft) && !draft.includes('ui-typed-secret-1'), `the editor inserted a chip ref, not the value: ${draft}`);
  await shot(d, 'editor-with-chip');
  await clickInTopDialog(d, 'Save');
  await sleep(800);
  const saved = await invoke(d, 'entry_get', { id: web.id });
  const secretId = REF_RE.exec(saved.notes ?? '')?.[1];
  const secret = secretId ? await invoke(d, 'entry_get_full', { id: secretId }) : null;
  check(secret?.password === 'ui-typed-secret-1' && !secret.config?.embedded?.orphaned_at, 'saving kept the secret encrypted, linked and in use');

  // 2. Reveal and copy the chip on the asset page.
  await open(d, async (id) => (await import('/src/lib/openDashboard.ts')).openDashboardForEntry(id), web.id, 'open web');
  await clickText(d, 'Notes', { exact: true, selector: '[role=tab]' });
  await waitFor(() => d.page.evaluate(() => !!document.querySelector('[data-cv-secret-chip]')), { timeoutMs: 10_000, label: 'chip shown' });
  await sleep(800);
  check(!(await d.page.evaluate(() => document.body.innerText.includes('no longer used in any notes'))), 'no "unused secret" banner for a secret the notes link to');
  const chipText = await d.page.evaluate(() => document.querySelector('[data-cv-secret-chip]')?.textContent ?? '');
  check(chipText.includes('Local admin') && !chipText.includes('ui-typed-secret-1'), `the chip shows its name, not the value: "${chipText}"`);
  await clickSelector(d, '[aria-label="Reveal Local admin"]');
  await waitForText(d, 'ui-typed-secret-1', { timeoutMs: 5_000 });
  await shot(d, 'chip-revealed');
  check(true, 'Reveal shows the value');
  await clickSelector(d, '[aria-label="Copy Local admin"]');
  await sleep(400);
  const clip = await mainEval(d, ({ clipboard }) => clipboard.readText(), null, { label: 'read clipboard' });
  check(clip === 'ui-typed-secret-1', 'Copy put the value on the clipboard');

  // 3. Split notes by headings from the migration banner.
  await open(d, async (id) => (await import('/src/lib/openDashboard.ts')).openDashboardForEntry(id), db.id, 'open db');
  await waitForText(d, 'These notes look like a knowledge base', { timeoutMs: 10_000 });
  await waitFor(() => clickVisible(d, '[role=status] button', 'Split by headings'), { timeoutMs: 10_000, label: 'Split by headings' });
  await waitFor(() => open(d, (id, s) => s.entry.getState().hiddenEntries.filter((e) => e.parent_entry_id === id).length === 3, db.id, 'count articles'), { timeoutMs: 10_000, label: 'three articles' });
  const kinds = await open(d, (id, s) => s.entry.getState().hiddenEntries.filter((e) => e.parent_entry_id === id).map((e) => `${e.name}:${e.config.kb.kind}`).sort(), db.id, 'read articles');
  check(JSON.stringify(kinds) === JSON.stringify(['Backups:facts', 'Failover:facts', 'Overview:overview']), `split made the expected articles: ${kinds}`);
  check((await invoke(d, 'entry_get', { id: db.id })).notes.startsWith('Primary.'), 'the notes were kept');
  await shot(d, 'split-into-articles');

  // 4. Remove the chip from the notes, then clean up the unused secret.
  await invoke(d, 'entry_update', { id: web.id, notes: 'nothing secret here' });
  await refreshEntries(d);
  await open(d, async (id) => (await import('/src/lib/openDashboard.ts')).openDashboardForEntry(id), web.id, 'open web again');
  await waitForText(d, 'no longer used in any notes', { timeoutMs: 10_000 });
  await shot(d, 'unused-secret-banner');
  await waitFor(() => clickVisible(d, '[role=status] button', 'Clean up'), { timeoutMs: 10_000, label: 'Clean up' });
  await clickInTopDialog(d, 'Delete');
  const gone = await waitFor(() => d.page.evaluate((id) => window.electron.invoke('entry_get', { id }).then(() => false, () => true), secretId), { timeoutMs: 10_000, label: 'secret deleted' }).catch(() => false);
  check(gone, 'Clean up deleted the unused secret');

  // 5. An agent edit, reviewed and undone in the article view.
  const mcp = await ctx.connectMcp(d);
  const art = (await mcp.callToolRaw('kb_write', { scope: 'asset', entry_id: web.id, kind: 'procedure', title: 'Restart', content: '1. restart nginx' })).data;
  await invoke(d, 'kb_keep', { id: art.id });
  await mcp.callToolRaw('kb_write', { article_id: art.id, content: '1. reboot the whole box', reason: 'agent guess' });
  await mcp.close?.();
  await refreshEntries(d);
  await open(d, async (id) => (await import('/src/components/knowledge/kbUi.ts')).openArticle(id), art.id, 'open article');
  await waitForText(d, 'Review what changed?', { timeoutMs: 10_000 });
  const tabs = await open(d, (id, s) => ({ paneTab: s.session.getState().sessions.some((x) => x.id === id) }), art.id, 'read tabs');
  const strip = await d.page.evaluate(() => [...document.querySelectorAll('[data-cv-article-tabs] [role=tab]')].filter((t) => t.getClientRects().length > 0).map((t) => t.textContent.trim()));
  check(!tabs.paneTab && JSON.stringify(strip) === JSON.stringify(['Info', 'Restart']), `the article opened as a sub-tab of the asset's Info tab: ${JSON.stringify({ strip, paneTab: tabs.paneTab })}`);
  await shot(d, 'article-sub-tab');
  await waitFor(() => clickVisible(d, '[role=status] button', 'Review'), { timeoutMs: 10_000, label: 'Review' });
  await waitForText(d, 'Review changes by', { timeoutMs: 10_000 });
  await shot(d, 'review-before-undo');
  await clickInTopDialog(d, 'Undo changes');
  const after = await waitFor(async () => {
    const e = await invoke(d, 'entry_get', { id: art.id });
    return e.config.content === '1. restart nginx' ? e : null;
  }, { timeoutMs: 10_000, label: 'undo applied' }).catch(() => invoke(d, 'entry_get', { id: art.id }));
  check(after.config.content === '1. restart nginx', `Undo restored the reviewed text: ${after.config.content}`);

  // 5b. The kind picker shows the new kind at once and saves it.
  await d.page.evaluate(() => {
    const sel = [...document.querySelectorAll('select[aria-label="Kind"]')].find((x) => x.getClientRects().length > 0);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'troubleshooting');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  const kindShown = await d.page.evaluate(() => [...document.querySelectorAll('select[aria-label="Kind"]')].find((x) => x.getClientRects().length > 0)?.value);
  const kindStored = (await invoke(d, 'entry_get', { id: art.id })).config.kb.kind;
  check(kindShown === 'troubleshooting' && kindStored === 'troubleshooting', `the kind picker kept the new kind (shown ${kindShown}, saved ${kindStored})`);

  // 6. Edit the article in the document view with a !!secret!!; it saves as a chip.
  await clickText(d, 'Edit', { exact: true, selector: 'button' });
  await typeInto(d, 'textarea', '1. restart nginx\nroot: !!ui-doc-secret-2!!');
  await clickText(d, 'Save', { exact: true, selector: 'button' });
  await waitFor(() => d.page.evaluate(() => !!document.querySelector('[data-cv-secret-chip]')), { timeoutMs: 10_000, label: 'article chip' });
  const stored = (await invoke(d, 'entry_get', { id: art.id })).config.content;
  check(REF_RE.test(stored) && !stored.includes('ui-doc-secret-2'), `the article saved the secret as a chip: ${stored}`);
  await shot(d, 'article-with-chip');
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  const step = (m) => log(m);
  step.file = (name) => run.logPath(name);
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step });
    try {
      const d = await launchInMode(ctx, 'ki', 'light');
      try {
        await flow(ctx, d);
      } catch (err) {
        check(false, `stopped: ${err.message.split('\n')[0]}`);
        await captureWindow(d, path.join(OUT, 'zz-failure.png'), { method: 'page' }).catch(() => {});
      }
      await ctx.quitDevice(d);
    } finally {
      await close();
    }
  } finally {
    await run.runCleanup();
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main().then((c) => process.exit(c));
