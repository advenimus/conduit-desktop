// Promo scenes S5 (AI) and S6 (startup).

import { clickSelector, clickText, exists, invoke, sleep, typeInto, waitFor, waitForText } from './ui.mjs';
import { openSettings, cancelSettings, switchSettingsTab } from './settings-flows.mjs';
import { prepareMain, showHome } from './promo-setup.mjs';
import { focusSessionTab, scrollHomeTop } from './promo-data.mjs';
import { setSidebar, withStores, VAULT_PASSWORD } from './restyle-data.mjs';

const SCRIPT = [
  "PROMPT='%F{green}ops@acme%f %F{blue}%~%f %# '; PROMPT2='%F{8}>%f '; clear",
  'echo "== Acme health check =="',
  'for h in web-01:nginx:12ms web-02:nginx:14ms api-01:api:31ms db-01:postgres:4ms; do',
  '  IFS=: read -r a b c <<< "$h"',
  "  printf '  %-8s %-9s \\e[32mOK\\e[0m  %s\\n' $a $b $c",
  '  sleep 0.2',
  'done',
  'echo "4/4 services healthy"',
];

async function typeLines(d, id, lines, gapMs) {
  for (const line of lines) {
    await invoke(d, 'terminal_write', { sessionId: id, data: [...Buffer.from(`${line}\r`)] });
    await sleep(gapMs);
  }
}

async function s5(ctx, rec) {
  const { d } = await prepareMain(ctx, 'p5', 'dark');
  const shell = await withStores(d, (_, s) => s.session.getState().createLocalShell(), null, { label: 'open a local shell' });
  await sleep(1200);
  await typeLines(d, shell, SCRIPT.slice(0, 1), 700);
  await typeLines(d, shell, SCRIPT.slice(1, -1), 250);
  await sleep(2500);
  await typeLines(d, shell, SCRIPT.slice(-1), 500);
  await sleep(800);
  await focusSessionTab(d, shell);
  await rec.shot(d, { scene: 's5', name: 'terminal-script', description: 'A local terminal tab after a multi-line script ran with clean output', targets: [{ label: 'Terminal', selector: '.xterm' }, { label: 'Tab bar', selector: '[data-tabbar]' }], settleMs: 800 });
  await setSidebar(d, 'hidden');
  await showHome(d);
  await scrollHomeTop(d);
  await d.page.evaluate(() => [...document.querySelectorAll('h2, h3, span, div')].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === 'AI activity'))?.scrollIntoView({ block: 'center' }));
  await rec.shot(d, { scene: 's5', name: 'ai-activity', description: 'Home with the AI activity card', targets: [{ label: 'AI activity', text: 'AI activity', card: true }], crop: { label: 'AI activity', pad: 40 } });
  await ctx.quitDevice(d);
}

async function s6(ctx, rec) {
  const { d } = await prepareMain(ctx, 'p6', 'dark', { ssh: ['web'] });
  await openSettings(d, 'security');
  await sleep(500);
  await clickSelector(d, 'button[role=switch][aria-label="Unlock automatically at startup"]');
  await waitForText(d, 'automatically?');
  if (await exists(d, 'input[placeholder="Enter master password"]')) await typeInto(d, 'input[placeholder="Enter master password"]', VAULT_PASSWORD);
  await clickText(d, 'Turn On', { exact: true, selector: '[data-dialog-content] button' });
  await waitFor(() => d.page.evaluate(() => document.querySelector('button[role=switch][aria-label="Unlock automatically at startup"]')?.getAttribute('aria-checked') === 'true'), { timeoutMs: 20_000, label: 'automatic unlock on' });
  await sleep(600);
  await rec.shot(d, { scene: 's6', name: 'security-auto-unlock', description: 'Settings > Security with Unlock automatically at startup on', targets: [{ label: 'Unlock automatically switch', selector: 'button[role=switch][aria-label="Unlock automatically at startup"]' }] });
  await switchSettingsTab(d, 'General');
  await sleep(700);
  await d.page.evaluate(() => document.querySelector('select[aria-label="Open at startup"]')?.scrollIntoView({ block: 'center' }));
  await rec.shot(d, { scene: 's6', name: 'general-startup', description: 'Settings > General with Open at startup set to the vault and automatic unlock on', targets: [{ label: 'Open at startup', selector: 'select[aria-label="Open at startup"]' }, { label: 'Unlocks automatically note', text: 'Unlocks automatically on this computer. Change in' }] });
  await cancelSettings(d);
  await setSidebar(d, 'docked');
  await rec.shot(d, { scene: 's6', name: 'sidebar-open-lock', description: 'The side bar vault name with the open-lock icon', targets: [{ label: 'Vault switcher', selector: '[data-cv-vault-switcher]' }] });
  await ctx.quitDevice(d);
}

export const MORE_SCENES = { s5, s6 };
