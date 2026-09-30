// Opt-in: screenshots of every new or changed control of docs/AUTO_UNLOCK.md in light and dark, saved
// to .verify/auto-unlock-shots/<name>-<scheme>.png. States a click cannot reach in a quiet device
// (stale, unreadable, the password-changed dialog, the opening screen) are set in the renderer's
// stores through the dev server, the way the app itself sets them.

import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../lib/run-context.mjs';
import { openSettings, switchSettingsTab, cancelSettings } from '../lib/settings-flows.mjs';
import { selectOption } from '../lib/ui-forms.mjs';
import { CHECKBOX_TEXT } from '../lib/startup-flows.mjs';
import { setCheckbox } from '../lib/ui-forms.mjs';
import { withTimeout } from '../lib/ui.mjs';

const PW = 'verify-shots-password-1';
const OUT = path.join(REPO, '.verify', 'auto-unlock-shots');
const DIALOG = '[data-dialog-content]';

async function shot(ctx, d, scheme, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await ctx.sleep(300);
  await d.page.screenshot({ path: path.join(OUT, `${name}-${scheme}.png`) });
  ctx.step(`saved ${name}-${scheme}.png`);
}

function inPage(d, fn, arg) {
  return withTimeout(d.page.evaluate(fn, arg), 15_000, `${d.name}: page call`);
}

/** Cancel in the topmost dialog (a confirm above Settings is the last one in the DOM). */
async function closeDialogByCancel(ctx, d) {
  const clicked = await inPage(d, (css) => {
    const buttons = [...document.querySelectorAll(css)].filter((b) => b.getClientRects().length > 0 && b.innerText.trim() === 'Cancel');
    const last = buttons[buttons.length - 1];
    last?.click();
    return Boolean(last);
  }, `${DIALOG} button, [role=dialog] button`);
  if (!clicked) throw new Error(`${d.name}: no Cancel button`);
  await ctx.sleep(300);
}

async function fallbackPrompt(d, fallback, openError) {
  await inPage(d, async ({ fallback: f, openError: e }) => {
    const { useStartupVaultStore } = await import('/src/stores/startupVaultStore.ts');
    const { useSyncStore } = await import('/src/stores/syncStore.ts');
    useStartupVaultStore.getState().setFallback(f);
    if (e) useSyncStore.getState().setOpenError(e);
    document.dispatchEvent(new CustomEvent('conduit:unlock-vault'));
  }, { fallback, openError });
}

async function run(ctx, scheme) {
  const tag = scheme === 'light' ? 'shl' : 'shd';
  const user = await ctx.createUser('pro');
  const d = await ctx.launchDevice(tag, { colorScheme: scheme });
  await ctx.flows.signIn(d, user);
  const dir = path.join(ctx.cloudDir, tag);
  fs.mkdirSync(dir, { recursive: true });
  const vault = path.join(dir, 'Work.conduit');
  await ctx.flows.createVault(d, vault, PW);
  await ctx.flows.lockVault(d);

  await ctx.ui.stubFileDialogs(d, vault);
  await ctx.ui.clickText(d, 'Open Vault File', { exact: true, selector: 'button' });
  await ctx.ui.waitForText(d, 'Unlock Vault');
  await ctx.ui.typeInto(d, 'input[placeholder="Enter master password"]', PW);
  await setCheckbox(d, CHECKBOX_TEXT, true, { scope: `${DIALOG} form` });
  await shot(ctx, d, scheme, '01-unlock-dialog-checkbox');
  await setCheckbox(d, CHECKBOX_TEXT, false, { scope: `${DIALOG} form` });
  await submitWithAutoUnlockShot(ctx, d, scheme);

  await inPage(d, async () => {
    const { useSidebarStore } = await import('/src/stores/sidebarStore.ts');
    useSidebarStore.getState().expand();
  });
  await ctx.ui.waitFor(() => ctx.ui.exists(d, '[data-cv-auto-unlock-indicator]'), { timeoutMs: 10_000, label: 'sidebar indicator' });
  await shot(ctx, d, scheme, '03-sidebar-indicator');
  await ctx.ui.clickSelector(d, '[data-cv-vault-switcher]');
  await ctx.sleep(300);
  await shot(ctx, d, scheme, '04-vault-menu-indicator');
  await ctx.ui.pressKey(d, 'Escape');
  await ctx.ui.clickSelector(d, '[data-cv-vault-switcher]').catch(() => undefined);
  await ctx.ui.pressKey(d, 'Escape');

  await openSettings(d, 'general');
  await ctx.ui.waitForText(d, 'Unlocks automatically on this computer');
  await shot(ctx, d, scheme, '05-settings-general-startup');
  await selectOption(d, 'select[aria-label="Open at startup"]', 'hub');
  await ctx.ui.waitForText(d, 'Turn off automatic unlock?');
  await shot(ctx, d, scheme, '06-confirm-change-startup');
  await closeDialogByCancel(ctx, d);
  await switchSettingsTab(d, 'Security');
  await ctx.ui.waitForText(d, 'Automatic Unlock');
  await shot(ctx, d, scheme, '07-settings-security-on');
  await ctx.ui.clickSelector(d, 'button[role=switch][aria-label="Unlock automatically at startup"]');
  await ctx.ui.waitFor(async () => (await ctx.ui.bodyText(d)).includes('Open Work without the master password'), { timeoutMs: 10_000, label: 'switched off' });
  await shot(ctx, d, scheme, '08-settings-security-off');
  await ctx.ui.clickSelector(d, 'button[role=switch][aria-label="Unlock automatically at startup"]');
  await ctx.ui.waitForText(d, 'Enter your master password to turn this on.');
  await shot(ctx, d, scheme, '09-warning-from-settings');
  await ctx.ui.typeInto(d, '[data-cv-auto-unlock-warning] input[placeholder="Enter master password"]', PW);
  await ctx.ui.clickText(d, 'Turn On', { exact: true, selector: '[data-cv-auto-unlock-warning] button' });
  await ctx.ui.waitFor(async () => !(await ctx.ui.exists(d, '[data-cv-auto-unlock-warning]')), { timeoutMs: 15_000, label: 'warning closed' });
  await cancelSettings(d);

  await ctx.flows.lockVault(d);
  await ctx.ui.waitForText(d, 'Startup');
  await shot(ctx, d, scheme, '10-hub-startup-badge');
  await ctx.ui.clickText(d, 'Clear All', { exact: true, selector: 'button' });
  await ctx.ui.waitForText(d, 'Clear recent vaults?');
  await shot(ctx, d, scheme, '11-confirm-clear-all');
  await closeDialogByCancel(ctx, d);

  await ctx.ui.clickSelector(d, `button[title="${vault}"]`);
  await ctx.ui.waitForText(d, 'Automatic unlock runs when Conduit starts.');
  await shot(ctx, d, scheme, '12-unlock-after-lock');
  await closeDialogByCancel(ctx, d);

  await fallbackPrompt(d, { kind: 'stale', name: 'Work' }, null);
  await ctx.ui.waitForText(d, "Conduit couldn't open Work automatically.");
  await shot(ctx, d, scheme, '13-unlock-stale');
  await closeDialogByCancel(ctx, d);

  await fallbackPrompt(d, { kind: 'unreadable', name: 'Work' }, null);
  await ctx.ui.waitForText(d, "couldn't read the saved unlock");
  await shot(ctx, d, scheme, '14-unlock-unreadable');
  await closeDialogByCancel(ctx, d);

  await fallbackPrompt(d, { kind: 'saved', name: 'Work' }, {
    code: 'VAULT_PASSWORD_CHANGED_ELSEWHERE', changedByDeviceName: 'MacBook Air', changedMs: Date.now() - 3_600_000, needsPreviousPassword: true, deleteBiometric: false,
  });
  await ctx.ui.waitForText(d, 'Master password changed');
  await shot(ctx, d, scheme, '15-password-changed-saved');
  await closeDialogByCancel(ctx, d);

  await inPage(d, async () => {
    const { useStartupVaultStore } = await import('/src/stores/startupVaultStore.ts');
    useStartupVaultStore.getState().setOpening({ text: 'Opening Work...', cancellable: true });
  });
  await ctx.ui.waitForText(d, 'Go to Vault Hub');
  await shot(ctx, d, scheme, '16-opening-screen');
  await inPage(d, async () => {
    const { useStartupVaultStore } = await import('/src/stores/startupVaultStore.ts');
    useStartupVaultStore.getState().setOpening(null);
  });
}

async function submitWithAutoUnlockShot(ctx, d, scheme) {
  await setCheckbox(d, CHECKBOX_TEXT, true, { scope: `${DIALOG} form` });
  await ctx.ui.clickSelector(d, `${DIALOG} form button[type=submit]`);
  await ctx.ui.waitForText(d, 'Unlock Work automatically?', { timeoutMs: 60_000 });
  await shot(ctx, d, scheme, '02-warning-after-unlock');
  await ctx.ui.clickText(d, 'Turn On', { exact: true, selector: `${DIALOG} button` });
  await ctx.flows.waitForUnlockOutcome(d);
}

export default {
  id: 'auto-unlock-shots',
  title: 'Screenshots of the startup vault and automatic unlock controls, light and dark',
  optIn: true,
  scenarios: [
    { id: 'shots-light', title: 'Every new control, light', run: (ctx) => run(ctx, 'light') },
    { id: 'shots-dark', title: 'Every new control, dark', run: (ctx) => run(ctx, 'dark') },
  ],
};
