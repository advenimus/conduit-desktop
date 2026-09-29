// Startup vault and automatic unlock, live (docs/AUTO_UNLOCK.md 8.2): the saved unlock survives a
// relaunch, a lock keeps asking, the escape hatch and "Go to Vault Hub", a stale saved password, no
// automatic take-over, a missing file, a startup vault without automatic unlock, sign-out and an
// account switch, the MCP hold, and a team startup vault. Each scenario has its own folder.

import fs from 'node:fs';
import path from 'node:path';
import { deviceUuid } from '../lib/sync-files.mjs';
import { lineageIdOf, workingCopyPath } from '../lib/vault-files.mjs';
import { sharedKeyState } from '../lib/password-flows.mjs';
import { readDeviceSettings, writeDeviceSettings } from '../lib/settings-file.mjs';
import { emitLockScreen } from '../lib/lifecycle-flows.mjs';
import { changeMasterPassword } from '../lib/settings-flows.mjs';
import { dialogSelector, toastLog, toastMark, waitForToast } from '../lib/ui-forms.mjs';
import { createTeamVault, ensureIdentityKey } from '../lib/team.mjs';
import {
  AFTER_LOCK_LINE,
  CHECKBOX_TEXT,
  HOLD_MESSAGE,
  KEEP_TEXT,
  autoUnlockFiles,
  closeWindow,
  mainLogText,
  openVaultWithAutoUnlock,
  recentRowMenu,
  showWindow,
  waitUnlocked,
  watchScreens,
} from '../lib/startup-flows.mjs';

const PW = 'verify-startup-password-1';
const NEW_PW = 'verify-startup-password-2';
const LEASE_MS = 15_000;
const SETTLE_MS = 3_000;
const PASSWORD_INPUT = 'input[placeholder="Enter master password"]';
const SUBMIT = '[data-dialog-content] form button[type=submit]';
const AUTO_SOURCE = "source: 'auto_unlock'";

const scratch = (ctx) => path.join(ctx.run.runDir, 'scratch');

function vaultIn(ctx, scenario, name = 'Vault.conduit') {
  const dir = path.join(ctx.cloudDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function waitLease(ctx, email, uuid, status, timeoutMs = LEASE_MS) {
  return ctx.waitFor(async () => (await ctx.leaseRows(email)).find((r) => r.device_id === uuid && r.status === status), { timeoutMs, label: `lease of ${uuid.slice(0, 8)} ${status}` });
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

async function signedInDevice(ctx, user, name, opts) {
  const d = await ctx.launchDevice(name, opts);
  const who = await ctx.flows.signIn(d, user);
  ctx.checkEqual(who.tier, user.role, `${name} signed in on the ${user.role} plan`);
  return d;
}

/** A user, a device and a vault in `tag`, with automatic unlock turned on from the unlock dialog. */
async function autoUnlockedVault(ctx, tag, { role = 'pro', user, env } = {}) {
  const u = user ?? (await ctx.createUser(role));
  const d = await signedInDevice(ctx, u, `${tag}a`, { env });
  const vault = vaultIn(ctx, tag);
  await ctx.flows.createVault(d, vault, PW);
  await ctx.flows.lockVault(d);
  await openVaultWithAutoUnlock(d, vault, PW);
  ctx.step(`${d.name}: automatic unlock is on for ${path.basename(vault)}`);
  return { user: u, d, vault };
}

/** Quits and relaunches `d`; returns the new device, the screens seen and where the main log started. */
async function relaunch(ctx, d, opts) {
  await ctx.quitDevice(d);
  const logFrom = fs.existsSync(d.mainLog) ? fs.statSync(d.mainLog).size : 0;
  const next = await ctx.launchDevice(d.name, opts);
  return { d: next, logFrom };
}

function logSince(d, from) {
  return mainLogText(d).slice(from);
}

/** Relaunches and expects the vault to open by itself, never showing the hub. */
async function relaunchAutomatic(ctx, d, opts) {
  const r = await relaunch(ctx, d, opts);
  const watched = await watchScreens(r.d, (screen, text) => screen === 'main' && !/Opening .*\.\.\./.test(text) && !text.includes('Loading...'));
  await waitUnlocked(r.d);
  ctx.check(!watched.seen.includes('hub'), `${r.d.name}: no Vault Hub on the way (screens: ${watched.seen.join(' > ')})`);
  await waitForToast(r.d, 'unlocked automatically');
  return { ...r, watched };
}

async function unlockDialogShown(ctx, d) {
  await ctx.ui.waitForText(d, 'Unlock Vault', { timeoutMs: 60_000 });
  await ctx.sleep(SETTLE_MS);
  ctx.check(!(await ctx.ui.invoke(d, 'vault_is_unlocked')), `${d.name}: still locked: the prompt asks for the password`);
}

// ---------- S1 ----------

async function autoUnlockRelaunch(ctx) {
  const { user, d, vault } = await autoUnlockedVault(ctx, 'u1');
  const settings = readDeviceSettings(d);
  ctx.checkEqual({ kind: settings.startup_vault?.kind, path: settings.startup_vault?.path }, { kind: 'personal', path: vault }, 'settings.startup_vault is this vault');
  ctx.check(typeof settings.startup_vault?.lineageId === 'string', 'settings.startup_vault has the lineage');
  ctx.checkEqual(autoUnlockFiles(d).length, 1, 'one sealed entry in auto-unlock/');
  ctx.check(!JSON.stringify(settings).includes(PW), 'settings.json never holds the password');
  await ctx.shot(d, 'turned-on');

  const r = await relaunchAutomatic(ctx, d);
  const d2 = r.d;
  ctx.step(`relaunch: ${r.watched.seen.join(' > ')}`);
  await waitForToast(d2, 'Vault unlocked automatically');
  ctx.check((await ctx.ui.invoke(d2, 'auto_unlock_status')).currentOn, 'Security state: this vault unlocks automatically (the sidebar icon source)');
  ctx.checkEqual(count(logSince(d2, r.logFrom), AUTO_SOURCE), 1, 'the main log has one auto_unlock unlock');
  ctx.check(logSince(d2, r.logFrom).includes(`personal vault unlocked { ${AUTO_SOURCE}`), 'the main log names source auto_unlock');
  ctx.check(!logSince(d2, r.logFrom).includes(PW), 'the main log never has the password');
  await waitLease(ctx, user.email, deviceUuid(d2), 'active');
  await ctx.shot(d2, 'opened-automatically');
}

// ---------- S2 ----------

async function lockAsksAgain(ctx) {
  const { d, vault } = await autoUnlockedVault(ctx, 'u2');
  let r = await relaunchAutomatic(ctx, d);
  let dev = r.d;

  await ctx.flows.lockVault(dev);
  await ctx.ui.clickSelector(dev, `button[title="${vault}"]`);
  await ctx.ui.waitForText(dev, AFTER_LOCK_LINE);
  ctx.check(!(await ctx.ui.bodyText(dev)).includes(CHECKBOX_TEXT), 'no checkbox: this vault already has a saved unlock');
  await ctx.shot(dev, 'after-lock-line');
  await ctx.ui.clickText(dev, 'Cancel', { exact: true, selector: '[data-dialog-content] button' });
  const mark = fs.statSync(dev.mainLog).size;
  await closeWindow(dev);
  await showWindow(dev);
  await ctx.sleep(SETTLE_MS);
  ctx.check(!(await ctx.ui.invoke(dev, 'vault_is_unlocked')), 'Lock, then close and show: still locked');
  ctx.checkEqual(count(logSince(dev, mark), AUTO_SOURCE), 0, 'no automatic attempt after a lock');
  ctx.step('Lock keeps asking, also across a close and show of the window');

  await ctx.ui.clickSelector(dev, `button[title="${vault}"]`);
  await ctx.ui.waitForText(dev, AFTER_LOCK_LINE);
  await ctx.ui.typeInto(dev, PASSWORD_INPUT, PW);
  await ctx.ui.clickSelector(dev, SUBMIT);
  await waitUnlocked(dev);
  await dev.page.evaluate(async () => {
    const { useSidebarStore } = await import('/src/stores/sidebarStore.ts');
    useSidebarStore.getState().expand();
  });
  await ctx.ui.waitFor(() => ctx.ui.exists(dev, '[data-cv-auto-unlock-indicator]'), { timeoutMs: 10_000, label: 'sidebar indicator after a typed unlock' });
  ctx.step('a typed unlock after the lock brings the sidebar indicator back');

  await ctx.quitDevice(dev);
  writeDeviceSettings(dev, { vault_idle_lock_minutes: 5 });
  r = await relaunchAutomatic(ctx, dev);
  dev = r.d;
  await emitLockScreen(dev);
  await ctx.waitFor(async () => !(await ctx.ui.invoke(dev, 'vault_is_unlocked')), { timeoutMs: 15_000, label: 'the screen lock locks' });
  await closeWindow(dev);
  await showWindow(dev);
  await ctx.sleep(SETTLE_MS);
  ctx.check(!(await ctx.ui.invoke(dev, 'vault_is_unlocked')), 'screen lock, then close and show: still locked');
  ctx.step('the screen lock (the idle lock path) keeps asking too');

  r = await relaunchAutomatic(ctx, dev);
  dev = r.d;
  const toastsBefore = (await toastLog(dev)).filter((t) => t.title.endsWith('unlocked automatically')).length;
  await closeWindow(dev);
  ctx.check(!(await ctx.ui.invoke(dev, 'vault_is_unlocked')), 'closing the window locks');
  ctx.step(`show reported by Electron itself: ${await showWindow(dev)}`);
  await waitUnlocked(dev);
  await ctx.waitFor(async () => (await toastLog(dev)).filter((t) => t.title.endsWith('unlocked automatically')).length > toastsBefore, { timeoutMs: 15_000, label: 'a second automatic open' });
  ctx.step('close and show with no lock in between: the vault opened by itself');
}

// ---------- S3 ----------

async function escapeHatch(ctx) {
  const { d, vault } = await autoUnlockedVault(ctx, 'u3');
  const before = readDeviceSettings(d).startup_vault;
  const r = await relaunch(ctx, d, { args: ['--no-startup-vault'] });
  await ctx.flows.waitForScreen(r.d, 'hub');
  await waitForToast(r.d, 'Startup vault skipped');
  await ctx.sleep(SETTLE_MS);
  ctx.check(!(await ctx.ui.invoke(r.d, 'vault_is_unlocked')), 'the vault stays locked');
  ctx.checkEqual(readDeviceSettings(r.d).startup_vault, before, 'the setting did not change');
  ctx.checkEqual(autoUnlockFiles(r.d).length, 1, 'the saved unlock is kept');
  ctx.checkEqual(count(logSince(r.d, r.logFrom), AUTO_SOURCE), 0, 'no automatic attempt');
  await ctx.shot(r.d, 'skipped');
  ctx.check(!(await ctx.ui.bodyText(r.d)).includes('Unlock Vault'), `${path.basename(vault)} is not prompted either`);
}

// ---------- S4 ----------

async function goToHub(ctx) {
  const proxy = await ctx.supabaseProxy();
  const { user, d } = await autoUnlockedVault(ctx, 'u4', { env: proxy.env });
  await ctx.quitDevice(d);
  proxy.stall();
  const d2 = await ctx.launchDevice(d.name, { env: proxy.env });
  await ctx.ui.waitForText(d2, 'Go to Vault Hub', { timeoutMs: 60_000 });
  const text = await ctx.ui.bodyText(d2);
  ctx.check(/Opening Vault\.\.\./.test(text), `the opening screen names the vault (${text.slice(0, 80)})`);
  await ctx.shot(d2, 'opening-screen');
  await ctx.ui.clickText(d2, 'Go to Vault Hub', { exact: true, selector: 'button' });
  await ctx.flows.waitForScreen(d2, 'hub');
  await waitForToast(d2, 'Startup vault skipped');
  proxy.restore();
  await ctx.sleep(SETTLE_MS * 2);
  ctx.check(!(await ctx.ui.invoke(d2, 'vault_is_unlocked')), 'the vault is locked');
  const leases = (await ctx.leaseRows(user.email)).filter((l) => l.device_id === deviceUuid(d2) && l.status === 'active');
  ctx.checkEqual(leases.length, 0, 'no lease left behind');
}

// ---------- S5 ----------

async function staleAfterChangeElsewhere(ctx) {
  const { user, d, vault } = await autoUnlockedVault(ctx, 'u5');
  const b = await signedInDevice(ctx, user, 'u5b');
  await ctx.flows.openVault(b, vault, PW, { expect: 'unlocked' });
  const lineage = lineageIdOf(vault, scratch(ctx));
  await ctx.quitDevice(d);
  const changed = await changeMasterPassword(b, PW, NEW_PW);
  ctx.check(changed.ok, `B changed the password (${JSON.stringify(changed)})`);
  await ctx.waitFor(() => sharedKeyState(vault, scratch(ctx)).epochs.length >= 2, { timeoutMs: 30_000, intervalMs: 500, label: 'the new key epoch in the shared file' });
  await ctx.quitDevice(b);
  const wc = workingCopyPath(d, lineage);
  for (const f of [wc, `${wc}-wal`, `${wc}-shm`]) fs.rmSync(f, { force: true });
  ctx.step('B changed the password; A was closed and its own copy is gone, so only the shared file can open');

  const r = await relaunch(ctx, d);
  const a = r.d;
  await ctx.ui.waitForText(a, "Conduit couldn't open Vault automatically.", { timeoutMs: 90_000 });
  ctx.checkEqual(autoUnlockFiles(a).length, 0, 'the stale saved unlock is forgotten at once');
  const text = await ctx.ui.bodyText(a);
  ctx.check(text.includes(KEEP_TEXT), 'the keep checkbox shows');
  ctx.check(await a.page.evaluate((t) => [...document.querySelectorAll('label')].find((l) => l.innerText.includes(t))?.querySelector('input')?.checked === true, KEEP_TEXT), 'the keep checkbox starts checked');
  const attempts = logSince(a, r.logFrom);
  ctx.checkEqual(count(attempts, `personal unlock refused { ${AUTO_SOURCE}`), 1, 'one automatic attempt, never a second');
  ctx.checkEqual(count(attempts, `personal vault unlocked { ${AUTO_SOURCE}`), 0, 'the stale password opened nothing');
  await ctx.shot(a, 'stale-prompt');

  await ctx.ui.typeInto(a, PASSWORD_INPUT, NEW_PW);
  await ctx.ui.clickSelector(a, SUBMIT);
  await waitUnlocked(a);
  await waitForToast(a, 'Saved unlock updated');
  ctx.checkEqual(autoUnlockFiles(a).length, 1, 'the new password is saved');
  const again = await relaunchAutomatic(ctx, a);
  ctx.step(`relaunch with the new saved password: ${again.watched.seen.join(' > ')}`);
}

// ---------- S6 ----------

async function freeOpenElsewhere(ctx) {
  const { user, d, vault } = await autoUnlockedVault(ctx, 'u6', { role: 'free' });
  await ctx.quitDevice(d);
  const b = await signedInDevice(ctx, user, 'u6b');
  await ctx.flows.openVault(b, vault, PW, { expect: 'unlocked' });
  await waitLease(ctx, user.email, deviceUuid(b), 'active');

  const r = await relaunch(ctx, d);
  const a = r.d;
  await ctx.waitFor(async () => (await ctx.flows.openDialogs(a)).includes('Vault open on another device'), { timeoutMs: 90_000, label: 'the take-over dialog' });
  await ctx.shot(a, 'takeover-from-startup');
  await ctx.sleep(SETTLE_MS);
  await waitLease(ctx, user.email, deviceUuid(b), 'active');
  ctx.check(await ctx.ui.invoke(b, 'vault_is_unlocked'), 'B keeps the vault: no automatic take-over');
  const mark = await toastMark(a);
  await ctx.ui.clickText(a, 'Cancel', { exact: true, selector: `${dialogSelector('Vault open on another device')} button` });
  await ctx.flows.waitForScreen(a, 'hub');
  await waitForToast(a, "Vault didn't open", { after: mark });
  ctx.check(!(await ctx.ui.exists(a, PASSWORD_INPUT)), 'Cancel went to the hub, not to a password form');
}

// ---------- S7 ----------

async function missingFile(ctx) {
  const { d, vault } = await autoUnlockedVault(ctx, 'u7');
  const before = readDeviceSettings(d).startup_vault;
  await ctx.quitDevice(d);
  const away = path.join(scratch(ctx), 'u7-Vault.conduit.away');
  fs.mkdirSync(scratch(ctx), { recursive: true });
  fs.renameSync(vault, away);
  let r = await relaunch(ctx, d);
  await ctx.flows.waitForScreen(r.d, 'hub');
  const toast = await waitForToast(r.d, "Couldn't find Vault.conduit");
  ctx.checkEqual(toast.actions, ['Open Vault File...', 'Stop Opening at Startup'], 'the missing-file toast offers both actions');
  ctx.checkEqual(readDeviceSettings(r.d).startup_vault, before, 'the startup choice is kept');
  await ctx.quitDevice(r.d);
  fs.renameSync(away, vault);
  r = await relaunchAutomatic(ctx, r.d);
  ctx.step('the file came back: the vault opens by itself again');
}

// ---------- S8 ----------

async function startupWithoutAuto(ctx) {
  const user = await ctx.createUser('pro');
  const d = await signedInDevice(ctx, user, 'u8a');
  const vault = vaultIn(ctx, 'u8');
  await ctx.flows.createVault(d, vault, PW);
  await ctx.flows.lockVault(d);
  const mark = await toastMark(d);
  await recentRowMenu(d, vault, 'start');
  await waitForToast(d, 'Vault opens at startup', { after: mark });
  ctx.checkEqual(readDeviceSettings(d).startup_vault?.path, vault, 'the hub menu set the startup vault');
  await ctx.waitFor(async () => (await ctx.ui.bodyText(d)).includes('Startup'), { timeoutMs: 10_000, label: 'the Startup badge' });
  await ctx.shot(d, 'startup-badge');
  const r = await relaunch(ctx, d);
  await unlockDialogShown(ctx, r.d);
  ctx.checkEqual(autoUnlockFiles(r.d).length, 0, 'nothing sealed');
  ctx.check((await ctx.ui.bodyText(r.d)).includes(CHECKBOX_TEXT), 'the prompt offers the checkbox');
  await ctx.shot(r.d, 'startup-prompt');
}

// ---------- S9 ----------

async function signOutForgets(ctx) {
  const { user, d } = await autoUnlockedVault(ctx, 'u9');
  await ctx.flows.lockVault(d);
  await ctx.flows.signOut(d);
  await ctx.waitFor(() => autoUnlockFiles(d).length === 0, { timeoutMs: 15_000, label: 'sign-out forgets the saved unlock' });
  await ctx.flows.signIn(d, user);
  const r = await relaunch(ctx, d);
  await unlockDialogShown(ctx, r.d);
}

// ---------- S10 ----------

async function accountSwitchForgets(ctx) {
  const { d } = await autoUnlockedVault(ctx, 'u10');
  const other = await ctx.createUser('pro');
  await ctx.flows.lockVault(d);
  const mark = await toastMark(d);
  await ctx.flows.signIn(d, other);
  await ctx.waitFor(() => autoUnlockFiles(d).length === 0, { timeoutMs: 15_000, label: 'the account change forgets the saved unlock' });
  await waitForToast(d, 'Automatic unlock is off', { after: mark });
  const r = await relaunch(ctx, d);
  await unlockDialogShown(ctx, r.d);
}

// ---------- S11 ----------

async function mcpAfterAutoUnlock(ctx) {
  const { d } = await autoUnlockedVault(ctx, 'u11');
  const r = await relaunchAutomatic(ctx, d);
  const dev = r.d;
  const mcp = await ctx.connectMcp(dev);
  const held = await mcp.callToolRaw('entry_list', {});
  ctx.check(held.isError && held.text.includes(HOLD_MESSAGE), `before anyone uses Conduit, MCP gets the locked error (${held.text.slice(0, 160)})`);
  await ctx.ui.pressKey(dev, 'Shift');
  const open = await ctx.waitFor(async () => {
    const res = await mcp.callToolRaw('entry_list', {});
    return res.isError ? null : res;
  }, { timeoutMs: 15_000, label: 'MCP works after a key press' });
  ctx.check(!open.isError, 'after a key press in the window, entry_list succeeds');
  await ctx.flows.lockVault(dev);
  const locked = await mcp.callToolRaw('entry_list', {});
  ctx.check(locked.isError && /VAULT_LOCKED|locked/i.test(locked.text), `after Lock, MCP gets the locked error again (${locked.text.slice(0, 160)})`);
}

// ---------- S12 ----------

async function teamStartup(ctx) {
  const user = await ctx.createUser('team');
  const team = await ctx.createTeam(user);
  const d = await signedInDevice(ctx, user, 'u12a');
  await ensureIdentityKey(d);
  const tv = await createTeamVault(d, team, `Startup team ${ctx.run.shortId}`);
  await ctx.ui.invoke(d, 'startup_vault_set', { kind: 'team', teamVaultId: tv.id });
  ctx.checkEqual(readDeviceSettings(d).startup_vault, { kind: 'team', teamVaultId: tv.id }, 'the team vault is the startup vault');
  const r = await relaunch(ctx, d);
  const watched = await watchScreens(r.d, async (screen) => screen === 'main' && (await ctx.ui.invoke(r.d, 'vault_get_type')) === 'team', { intervalMs: 50 });
  ctx.check(watched.texts.some((t) => t.includes('Connecting to team vault...') && t.includes('Go to Vault Hub')), 'the opening screen had "Go to Vault Hub"');
  ctx.check(!watched.seen.includes('hub'), `no Vault Hub on the way (${watched.seen.join(' > ')})`);
  await ctx.shot(r.d, 'team-opened');
}

export default {
  id: 'startup',
  title: 'Startup vault and automatic unlock',
  scenarios: [
    { id: 'auto-unlock-relaunch', title: 'Pro: turn it on from the unlock dialog; a relaunch opens the vault with no Hub, a lease and a toast', run: autoUnlockRelaunch },
    { id: 'lock-asks-again', title: 'After Lock or the screen lock the password is asked, even across a close and show; a close with no lock reopens by itself', run: lockAsksAgain },
    { id: 'escape-hatch', title: '--no-startup-vault shows the Hub once, with a toast, and changes nothing', run: escapeHatch },
    { id: 'go-to-hub', title: 'A stalled automatic open: "Go to Vault Hub" leaves it locked with no lease', run: goToHub },
    { id: 'stale-after-change-elsewhere', title: 'A saved password changed elsewhere is forgotten at once, tried once, and re-saved from the prompt', run: staleAfterChangeElsewhere },
    { id: 'free-open-elsewhere', title: 'Free, open on B: the take-over dialog, no automatic take-over; Cancel goes to the Hub', run: freeOpenElsewhere },
    { id: 'missing-file', title: 'A missing startup vault: the Hub with a toast; the file comes back and it opens again', run: missingFile },
    { id: 'startup-without-auto', title: 'Open at Startup from the Hub menu without a saved unlock: the prompt shows at start', run: startupWithoutAuto },
    { id: 'sign-out-forgets', title: 'Sign Out forgets the saved unlock', run: signOutForgets },
    { id: 'account-switch-forgets', title: 'Another account signing in forgets the saved unlock', run: accountSwitchForgets },
    { id: 'mcp-after-auto-unlock', title: 'After an automatic unlock MCP waits for a key press, and a Lock stops it again', run: mcpAfterAutoUnlock },
    { id: 'team-startup', title: 'A team startup vault opens at start, from an opening screen with "Go to Vault Hub"', run: teamStartup },
  ],
};
