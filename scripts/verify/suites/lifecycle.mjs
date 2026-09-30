// Vault lifecycle, live (docs/MULTI_DEVICE_SYNC.md 4.7, 5.9, 3.2 and the Settings Sync tab):
// Recently deleted and "Delete permanently", renaming a shared vault and the other device's
// automatic rebind, making a separate vault, a damaged working copy, the idle auto-lock, and the
// plan line and devices list on Settings > Sync. Each scenario uses its own folder in the cloud dir.

import fs from 'node:fs';
import path from 'node:path';
import { deviceUuid, sharedEntries } from '../lib/sync-files.mjs';
import { waitForDialog, waitForEntry } from '../lib/sync-flows.mjs';
import { cancelSettings, openSettings, openSyncTool, readSyncTab, setIdleLockMinutes } from '../lib/settings-flows.mjs';
import { closeRecentlyDeleted, deletePermanently, recentlyDeletedItems, restoreDeleted } from '../lib/sync-panels.mjs';
import { answerSameDeviceCopy, DAMAGED_TITLE, rebuildDamagedCopy } from '../lib/sync-dialogs.mjs';
import { banners, clickToastAction, toastMark, waitForToast } from '../lib/ui-forms.mjs';
import { corruptWorkingCopy, lineageIdOf, makeUserCopy, parkedWorkingCopies, workingCopyPath } from '../lib/vault-files.mjs';
import { readDeviceSettings, waitForSetting } from '../lib/settings-file.mjs';
import { bytesContaining, entryStorage, fileSha256, historyPasswordCiphers, storedPasswordCipher, vaultIdentity } from '../lib/vault-inspect.mjs';
import { emitLockScreen, idleChecks, renameVaultFromMenu, stubSystemIdle, unlockShownDialog, waitRecentlyDeleted } from '../lib/lifecycle-flows.mjs';

const PW = 'verify-lifecycle-password-1';
const CONVERGE_MS = 30_000;
// 5.9: missing for 30 s of repeated stat calls, then the folder listing and the rebind.
const REBIND_MS = 75_000;
// electron/services/vault/idle-lock.ts checks every 30 s; one check may land just after the stub.
const IDLE_CHECK_WINDOW_MS = 45_000;
const IDLE_MINUTES = 5;
const RELEASE_MS = 10_000;

const scratch = (ctx) => path.join(ctx.run.runDir, 'scratch');

function vaultIn(ctx, scenario, name = 'Vault.conduit') {
  const dir = path.join(ctx.cloudDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

async function signedIn(ctx, user, names) {
  const devices = await Promise.all(names.map((n) => ctx.launchDevice(n)));
  const who = await Promise.all(devices.map((d) => ctx.flows.signIn(d, user)));
  for (const w of who) ctx.checkEqual(w.tier, user.role, `signed in on the ${user.role} plan`);
  return devices;
}

/** A Pro user with `file` created on A (plus an entry) and open on B too. */
async function proPair(ctx, scenario, entryFields) {
  const user = await ctx.createUser('pro');
  const [a, b] = await signedIn(ctx, user, [`${scenario}a`, `${scenario}b`]);
  const vault = vaultIn(ctx, scenario);
  await ctx.flows.createVault(a, vault, PW);
  const entry = await ctx.flows.addEntry(a, entryFields);
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id), 'A published the entry');
  await ctx.flows.openVault(b, vault, PW, { expect: 'unlocked' });
  await waitForEntry(b, entry.id, (e) => e !== null, { label: 'B has the entry' });
  return { user, a, b, vault, entry };
}

function waitShared(ctx, file, pred, label, timeoutMs = CONVERGE_MS) {
  return ctx.waitFor(() => (fs.existsSync(file) && pred(sharedEntries(file, scratch(ctx)))) || null, { timeoutMs, intervalMs: 500, label: `shared file: ${label}` });
}

async function passwordOf(ctx, device, id) {
  return (await ctx.ui.invoke(device, 'entry_get_full', { id }))?.password ?? null;
}

function waitLease(ctx, email, uuid, status, timeoutMs) {
  return ctx.waitFor(async () => (await ctx.leaseRows(email)).find((r) => r.device_id === uuid && r.status === status), { timeoutMs, label: `lease of ${uuid.slice(0, 8)} ${status}` });
}

/** Recently deleted as the panel shows it (opened from Settings > Sync, then closed again). */
async function deletedInPanel(ctx, device, label) {
  await openSyncTool(device, 'Recently deleted');
  const items = await recentlyDeletedItems(device);
  await ctx.shot(device, label);
  await closeRecentlyDeleted(device);
  await cancelSettings(device);
  return items;
}

// ---------- L1: Recently deleted, restore and Delete permanently ----------

async function recentlyDeleted(ctx) {
  const id = ctx.run.shortId;
  const secret = { name: `L1 secret ${id}`, host: `l1-${id}.secret.example`, username: `l1user-${id}`, notes: `l1 notes ${id}` };
  const [oldPassword, password] = [`l1-old-password-${id}`, `l1-password-${id}`];
  const { a, b, vault, entry } = await proPair(ctx, 'l1', { ...secret, password: oldPassword, port: 22 });
  const title = secret.name;
  const both = [a, b];
  await ctx.flows.updateEntry(a, entry.id, { password });
  await ctx.waitFor(async () => (await passwordOf(ctx, b, entry.id)) === password, { timeoutMs: CONVERGE_MS, label: 'B decrypts the changed password' });
  const oldCipher = await ctx.waitFor(() => historyPasswordCiphers(vault, entry.id, scratch(ctx))[0] ?? null, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'the shared file has the password history row' });

  await ctx.flows.deleteEntry(a, entry.id);
  await Promise.all(both.map((d) => waitForEntry(d, entry.id, (e) => e === null, { label: 'entry deleted' })));
  await Promise.all(both.map((d) => waitRecentlyDeleted(d, (items) => items.some((i) => i.title === title && !i.redacted), { label: `${title} listed` })));
  for (const d of both) ctx.check((await deletedInPanel(ctx, d, 'deleted-listed')).some((r) => r.title === title && !r.erased), `${d.name}: the panel lists "${title}"`);
  const grave = entryStorage(vault, entry.id, scratch(ctx)).grave;
  ctx.check(grave?.redacted === 0 && typeof grave.rowJson === 'string' && grave.rowJson.includes(secret.host), `the shared file keeps a grave with the entry's values (${JSON.stringify(grave)?.slice(0, 120)})`);
  ctx.step('deleted on A; listed in Recently deleted on A and B; the shared file has its grave');

  await openSyncTool(b, 'Recently deleted');
  await restoreDeleted(b, [title]);
  await closeRecentlyDeleted(b);
  await cancelSettings(b);
  for (const d of both) {
    await waitForEntry(d, entry.id, (e) => e?.host === secret.host, { timeoutMs: CONVERGE_MS, label: 'entry restored' });
    ctx.checkEqual(await passwordOf(ctx, d, entry.id), password, `${d.name}: the restored entry has its password`);
  }
  await Promise.all(both.map((d) => waitRecentlyDeleted(d, (items) => !items.some((i) => i.title === title), { label: `${title} gone after restore` })));
  const cipher = await ctx.waitFor(() => (fs.existsSync(vault) && storedPasswordCipher(vault, entry.id, scratch(ctx))) || null, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'the restored entry is back in the shared file' });
  ctx.step(`restored on B; back on A and B with its password; the shared file stores a ${cipher.length}-byte password cipher`);

  await ctx.flows.deleteEntry(b, entry.id);
  await Promise.all(both.map((d) => waitRecentlyDeleted(d, (items) => items.some((i) => i.title === title && !i.redacted), { label: `${title} deleted again` })));
  await ctx.waitFor(() => {
    const s = entryStorage(vault, entry.id, scratch(ctx));
    return s.grave?.redacted === 0 && s.grave.rowJson ? s : null;
  }, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'B published the second delete' });
  ctx.step(`grave password value: ${graveSecretShape(vault, entry.id, ctx)}`);
  const needles = { ...secret, password: cipher, 'old password': oldCipher };
  ctx.checkEqual(bytesContaining(vault, needles), Object.keys(needles), 'before the erase, every value of the entry and its history is in the shared file');

  await openSyncTool(a, 'Recently deleted');
  await deletePermanently(a, [title]);
  await ctx.shot(a, 'erased');
  await closeRecentlyDeleted(a);
  await cancelSettings(a);
  await Promise.all(both.map((d) => waitRecentlyDeleted(d, (items) => !items.some((i) => i.title === title) && items.some((i) => i.redacted), { label: 'only an erased record left' })));
  for (const d of both) ctx.check(!(await deletedInPanel(ctx, d, 'after-erase')).some((r) => r.title === title), `${d.name}: "${title}" is gone from the panel`);

  const after = await ctx.waitFor(() => {
    const s = entryStorage(vault, entry.id, scratch(ctx));
    return s.grave?.redacted === 1 ? s : null;
  }, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'A published the redaction' });
  ctx.checkEqual({ rowJson: after.grave.rowJson, redacted: after.grave.redacted, contentRow: after.contentRow }, { rowJson: null, redacted: 1, contentRow: false }, 'the grave is redacted and no content row is left');
  ctx.check(after.regs.contentRegs > 0 && after.regs.allRedacted, `every register of the row is redacted: ${JSON.stringify(after.regs)}`);
  ctx.checkEqual(bytesContaining(vault, needles), [], 'no name, host, username, notes, password cipher or old password cipher is left in the shared file');
  ctx.step(`erased on A; shared file grave ${JSON.stringify(after.grave)}, ${after.regs.contentRegs} registers redacted, history rows ${after.history.contentRows}`);
}

/** Shape of the grave's password value (logged to confirm the byte search covers its encoding). */
function graveSecretShape(vault, entryId, ctx) {
  const row = JSON.parse(entryStorage(vault, entryId, scratch(ctx)).grave.rowJson);
  return JSON.stringify(row.password).replace(/[A-Za-z0-9+/=_-]{12,}/g, (m) => `<${m.length} chars>`);
}

// ---------- L2: rename on A, automatic rebind on B ----------

async function renameAndRebind(ctx) {
  const { user, a, b, vault, entry } = await proPair(ctx, 'l2', { name: 'l2 server', host: '10.2.0.1', port: 22 });
  const renamed = path.join(path.dirname(vault), 'Renamed.conduit');
  const markB = await toastMark(b);
  const t0 = Date.now();
  const toast = await renameVaultFromMenu(a, 'Renamed');
  ctx.step(`A: toast "${toast.title}"`);
  ctx.checkEqual([fs.existsSync(vault), fs.existsSync(renamed)], [false, true], 'the shared file was renamed, not copied');
  ctx.checkEqual(await ctx.ui.invoke(a, 'vault_get_path'), renamed, 'A works at the new path');
  ctx.checkEqual((await ctx.ui.readSyncState(a)).vault?.fileName, 'Renamed.conduit', 'A syncs the renamed file');
  ctx.checkEqual(readDeviceSettings(a).last_vault_path, renamed, 'A remembers the new path');
  await ctx.flows.updateEntry(a, entry.id, { host: '10.2.0.2' });
  await waitShared(ctx, renamed, (rows) => rows.some((r) => r.id === entry.id && r.host === '10.2.0.2'), 'A publishes into the renamed file');
  await ctx.shot(a, 'renamed');

  const rebound = await waitForToast(b, 'Found the vault file under its new name.', { after: markB, timeoutMs: REBIND_MS });
  ctx.step(`B rebound ${((Date.now() - t0) / 1000).toFixed(1)} s after the rename: "${rebound.title}" ${rebound.message ?? ''} [${rebound.actions.join(', ')}]`);
  ctx.checkEqual([rebound.message, rebound.actions], ['Renamed.conduit', ['Undo']], 'the rebind toast names the new file and offers [Undo]');
  ctx.checkEqual((await banners(b)).filter((x) => /Vault file not found/.test(x.text)), [], 'B shows no file-not-found banner');
  await waitForEntry(b, entry.id, (e) => e?.host === '10.2.0.2', { timeoutMs: CONVERGE_MS, label: 'B gets A\'s edit after the rebind' });
  ctx.checkEqual((await ctx.ui.readSyncState(b)).vault?.fileName, 'Renamed.conduit', 'B syncs the renamed file');
  ctx.checkEqual(await ctx.ui.invoke(b, 'vault_get_path'), renamed, 'B works at the new path');
  const sb = readDeviceSettings(b);
  ctx.checkEqual([sb.last_vault_path, sb.recent_vaults], [renamed, [renamed]], 'B remembers the new path, not the missing one');
  await ctx.shot(b, 'rebound');

  await ctx.flows.updateEntry(b, entry.id, { port: 2202 });
  await waitForEntry(a, entry.id, (e) => e?.port === 2202 && e?.host === '10.2.0.2', { timeoutMs: CONVERGE_MS, label: 'A gets B\'s edit' });
  await waitShared(ctx, renamed, (rows) => rows.some((r) => r.id === entry.id && r.port === 2202), 'B publishes into the renamed file');
  ctx.check(!fs.existsSync(vault), 'nothing recreated the file at the old path');
  const leases = await ctx.leaseRows(user.email);
  ctx.checkEqual(leases.map((r) => r.status).sort(), ['active', 'active'], 'both devices still hold their lease');
  ctx.step('A and B keep syncing through Renamed.conduit');

  await ctx.quitDevice(b);
  const b2 = await ctx.launchDevice('l2b');
  await ctx.flows.waitForScreen(b2, 'hub');
  const recent = await ctx.ui.withTimeout(b2.page.evaluate(() => [...document.querySelectorAll('button[title$=".conduit"]')].map((el) => el.getAttribute('title'))), 10_000, 'read recent vaults');
  ctx.checkEqual(recent, [renamed], 'after a relaunch the hub offers the renamed file only');
  await ctx.ui.clickSelector(b2, `button[title="${renamed.replace(/"/g, '\\"')}"]`);
  ctx.checkEqual((await unlockShownDialog(b2, PW)).outcome, 'unlocked', 'B reopens the renamed file from its recent list');
  await waitForEntry(b2, entry.id, (e) => e?.port === 2202, { label: 'B after the relaunch' });
}

// ---------- L3: make a separate vault ----------

async function makeSeparateVault(ctx) {
  const user = await ctx.createUser('pro');
  const [a] = await signedIn(ctx, user, ['l3a']);
  const original = vaultIn(ctx, 'l3');
  await ctx.flows.createVault(a, original, PW);
  const entry = await ctx.flows.addEntry(a, { name: 'l3 original', host: '10.3.0.1', port: 22 });
  await waitShared(ctx, original, (rows) => rows.some((r) => r.id === entry.id), 'A published the entry');
  await ctx.flows.lockVault(a);
  const copy = makeUserCopy(original);
  const before = { sha: fileSha256(original), id: vaultIdentity(original, scratch(ctx)) };
  ctx.step(`original ${path.basename(original)} sha ${before.sha.slice(0, 12)}, lineage ${before.id.lineageId}; copy ${path.basename(copy)}`);

  await ctx.flows.openVault(a, copy, PW, { expect: 'unlocked' });
  const banner = await ctx.waitFor(async () => (await banners(a)).find((x) => x.text.includes(' is a copy of ')), { timeoutMs: CONVERGE_MS, label: 'the same-device copy banner' });
  ctx.checkEqual(banner.text, `'Vault.conduit' is a copy of '${path.basename(copy)}'.`, 'the banner names the original as a copy');
  await ctx.shot(a, 'copy-banner');
  const target = path.join(path.dirname(original), 'Separate.conduit');
  const mark = await toastMark(a);
  await answerSameDeviceCopy(a, 'separate', { copyName: 'Vault.conduit', targetPath: target });
  const saved = await waitForToast(a, 'Saved as a separate vault.', { after: mark });
  ctx.checkEqual(saved.actions, ['Open it'], 'the toast offers [Open it]');
  const fork = vaultIdentity(target, scratch(ctx));
  ctx.check(fork.lineageId && fork.lineageId !== before.id.lineageId && fork.genesisId !== before.id.genesisId && fork.vaultId !== before.id.vaultId, `the new file has its own lineage, genesis and vault id: ${JSON.stringify(fork)} vs ${JSON.stringify(before.id)}`);
  ctx.checkEqual(fileSha256(original), before.sha, 'the original file is byte-for-byte untouched by the fork');

  await clickToastAction(a, 'Saved as a separate vault.', 'Open it');
  const opened = await unlockShownDialog(a, PW);
  ctx.checkEqual(opened.outcome, 'unlocked', `the separate vault opens with the same password (${opened.dialogs?.join(', ') ?? ''})`);
  const state = await ctx.ui.readSyncState(a);
  ctx.checkEqual([state.vault?.fileName, state.status?.lineageId], ['Separate.conduit', fork.lineageId], 'A now syncs the separate vault under its new lineage');
  await waitForEntry(a, entry.id, (e) => e?.host === '10.3.0.1', { label: 'the separate vault has the original entries' });
  await ctx.shot(a, 'separate-open');

  await ctx.flows.updateEntry(a, entry.id, { host: '10.3.9.9' });
  const only = await ctx.flows.addEntry(a, { name: 'l3 separate only', host: '10.3.9.1', port: 22 });
  await waitShared(ctx, target, (rows) => rows.some((r) => r.id === only.id) && rows.some((r) => r.id === entry.id && r.host === '10.3.9.9'), 'the separate vault publishes its edits');
  await ctx.flows.lockVault(a);
  ctx.checkEqual(fileSha256(original), before.sha, 'the original file is byte-for-byte untouched after edits in the separate vault');
  for (const f of [original, copy]) {
    const rows = sharedEntries(f, scratch(ctx));
    ctx.checkEqual(rows.map((r) => [r.name, r.host]), [['l3 original', '10.3.0.1']], `${path.basename(f)} has none of the separate vault's edits`);
  }
  ctx.step('Separate.conduit is a new vault; its edits never reach Vault.conduit or its copy');
}

// ---------- L4: damaged working copy ----------

async function damagedWorkingCopy(ctx) {
  const { a, b, vault, entry } = await proPair(ctx, 'l4', { name: 'l4 from A', host: '10.4.0.1', port: 22, password: 'l4-password' });
  const lineageId = lineageIdOf(vault, scratch(ctx));
  await ctx.quitDevice(a);
  const fromB = await ctx.flows.addEntry(b, { name: 'l4 from B', host: '10.4.0.2', port: 22 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === fromB.id), 'B published while A was closed');
  const bad = corruptWorkingCopy(a, lineageId);
  const damagedSha = fileSha256(bad.path);
  ctx.step(`corrupted A's working copy ${path.relative(ctx.run.tmpRoot, bad.path)}`);

  const a2 = await ctx.launchDevice('l4a');
  await ctx.flows.waitForScreen(a2, 'hub');
  const res = await ctx.flows.openVault(a2, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [DAMAGED_TITLE] }, 'the unlock offers the damaged-copy recovery');
  // res.text is read just before the dialog check of the same poll, so it can predate the dialog.
  const dialog = await waitForDialog(a2, DAMAGED_TITLE);
  ctx.check(dialog.text.includes('The damaged copy is kept, not deleted.'), `the dialog says the damaged copy is kept: ${dialog.text.slice(0, 300)}`);
  await ctx.shot(a2, 'damaged-dialog');
  const out = await rebuildDamagedCopy(a2);
  ctx.checkEqual(out.outcome, 'unlocked', 'the vault opens after [Rebuild from shared file]');
  await waitForEntry(a2, fromB.id, (e) => e?.host === '10.4.0.2', { label: 'the entry only the shared file had' });
  ctx.checkEqual(await passwordOf(ctx, a2, entry.id), 'l4-password', 'A\'s own entry and its password come back from the shared file');
  const parked = parkedWorkingCopies(a2, lineageId);
  ctx.checkEqual(parked.length, 1, `one parked copy (${parked.join(', ')})`);
  const parkedPath = path.join(path.dirname(workingCopyPath(a2, lineageId)), 'parked', parked[0]);
  ctx.checkEqual(fileSha256(parkedPath), damagedSha, 'the parked file is the damaged copy, byte for byte');
  ctx.check(fileSha256(workingCopyPath(a2, lineageId)) !== damagedSha, 'a fresh working copy replaced it');
  await ctx.flows.updateEntry(a2, fromB.id, { port: 2204 });
  await waitForEntry(b, fromB.id, (e) => e?.port === 2204, { timeoutMs: CONVERGE_MS, label: 'B gets A\'s edit after the rebuild' });
  await ctx.shot(a2, 'rebuilt');
}

// ---------- L5: idle auto-lock ----------

async function idleSelect(ctx, device) {
  await openSettings(device, 'security');
  const value = await ctx.ui.withTimeout(device.page.evaluate(() => document.querySelector('select[aria-label="Lock the vault when idle"]')?.value ?? null), 10_000, 'read idle select');
  await cancelSettings(device);
  return value;
}

async function idleAutoLock(ctx) {
  const user = await ctx.createUser('pro');
  const [a] = await signedIn(ctx, user, ['l5a']);
  const vault = vaultIn(ctx, 'l5');
  await ctx.flows.createVault(a, vault, PW);
  await setIdleLockMinutes(a, IDLE_MINUTES);
  await waitForSetting(a, 'vault_idle_lock_minutes', (v) => v === IDLE_MINUTES);
  ctx.checkEqual(await idleSelect(ctx, a), String(IDLE_MINUTES), 'Settings shows the saved idle lock');
  await ctx.quitDevice(a);
  ctx.checkEqual(readDeviceSettings(a).vault_idle_lock_minutes, IDLE_MINUTES, 'settings.json keeps it after quit');
  const a2 = await ctx.launchDevice('l5a');
  await ctx.flows.waitForScreen(a2, 'hub');
  await ctx.flows.openVault(a2, vault, PW, { expect: 'unlocked' });
  ctx.checkEqual(await idleSelect(ctx, a2), String(IDLE_MINUTES), 'Settings shows it after a relaunch');
  const uuid = deviceUuid(a2);
  await waitLease(ctx, user.email, uuid, 'active', RELEASE_MS);

  const limitS = IDLE_MINUTES * 60;
  await stubSystemIdle(a2, limitS - 1);
  await ctx.waitFor(async () => (await idleChecks(a2)) >= 1, { timeoutMs: IDLE_CHECK_WINDOW_MS, intervalMs: 500, label: 'an idle check below the limit' });
  ctx.check(await ctx.ui.invoke(a2, 'vault_is_unlocked'), `idle ${limitS - 1} s: still unlocked`);
  const t0 = Date.now();
  await stubSystemIdle(a2, limitS);
  await ctx.waitFor(async () => !(await ctx.ui.invoke(a2, 'vault_is_unlocked')), { timeoutMs: IDLE_CHECK_WINDOW_MS, intervalMs: 500, label: `locked at ${limitS} s idle` });
  ctx.step(`idle ${limitS} s: locked ${((Date.now() - t0) / 1000).toFixed(1)} s later`);
  await ctx.flows.waitForScreen(a2, 'hub', { timeoutMs: 15_000 });
  await waitLease(ctx, user.email, uuid, 'released', RELEASE_MS);
  ctx.check(fs.readFileSync(a2.mainLog, 'utf8').includes("vault locked automatically { trigger: 'idle' }"), 'the main log names the idle trigger');
  await ctx.shot(a2, 'idle-locked');

  await stubSystemIdle(a2, 0);
  await ctx.flows.openVault(a2, vault, PW, { expect: 'unlocked' });
  await waitLease(ctx, user.email, uuid, 'active', RELEASE_MS);
  await emitLockScreen(a2);
  await ctx.waitFor(async () => !(await ctx.ui.invoke(a2, 'vault_is_unlocked')), { timeoutMs: 10_000, label: 'locked by the screen lock' });
  await waitLease(ctx, user.email, uuid, 'released', RELEASE_MS);
  ctx.step('the OS screen lock locks at once and releases the lease');

  await ctx.flows.openVault(a2, vault, PW, { expect: 'unlocked' });
  await setIdleLockMinutes(a2, 0);
  await waitForSetting(a2, 'vault_idle_lock_minutes', (v) => v === 0);
  await emitLockScreen(a2);
  await ctx.sleep(2_000);
  ctx.check(await ctx.ui.invoke(a2, 'vault_is_unlocked'), 'with the setting Off, the screen lock leaves the vault open');
  await waitLease(ctx, user.email, uuid, 'active', RELEASE_MS);
}

// ---------- L6: Settings > Sync ----------

async function syncTab(ctx) {
  const free = await ctx.createUser('free');
  const [f] = await signedIn(ctx, free, ['l6f']);
  await ctx.flows.createVault(f, vaultIn(ctx, 'l6', 'Free.conduit'), PW);
  await ctx.waitFor(async () => (await ctx.ui.readSyncState(f)).status?.kind === 'up-to-date', { timeoutMs: CONVERGE_MS, label: 'free device up to date' });
  const ft = await readSyncTab(f);
  ctx.checkEqual(ft.plan, 'Your plan: a vault can be open on one device at a time. Team vaults sync through your team.', 'Free plan line');
  ctx.checkEqual((await ctx.ui.readSyncState(f)).deviceLimit?.limit, 1, 'the Free device limit is 1');
  ctx.checkEqual([ft.status, ft.devices.length], ['Up to date', 1], `Free: status and one device (${JSON.stringify(ft.devices)})`);
  ctx.check(ft.devices[0].name.endsWith('(this device)') && ft.devices[0].line.startsWith('Open now'), `Free: this device is open (${JSON.stringify(ft.devices[0])})`);
  await ctx.shot(f, 'sync-tab-free');
  await cancelSettings(f);

  const { a, b } = await proPair(ctx, 'l6', { name: 'l6 server', host: '10.6.0.1', port: 22 });
  const pro = await ctx.waitFor(async () => {
    const t = await readSyncTab(a);
    if (t.devices.length === 2) return t;
    await cancelSettings(a);
    return null;
  }, { timeoutMs: CONVERGE_MS, intervalMs: 1_000, label: 'A lists both devices' });
  ctx.checkEqual(pro.plan, 'Your plan: a vault can be open on any number of devices at once. Team vaults sync through your team.', 'Pro plan line');
  ctx.checkEqual((await ctx.ui.readSyncState(a)).deviceLimit?.limit, -1, 'the Pro device limit is unlimited');
  const [own, other] = [pro.devices.find((d) => d.name.endsWith('(this device)')), pro.devices.find((d) => !d.name.endsWith('(this device)'))];
  ctx.check(own?.line.startsWith('Open now') && other?.line.startsWith('Open now'), `Pro: both devices open (${JSON.stringify(pro.devices)})`);
  await ctx.shot(a, 'sync-tab-pro');
  await cancelSettings(a);

  await ctx.quitDevice(b);
  const closed = await ctx.waitFor(async () => {
    const t = await readSyncTab(a);
    await cancelSettings(a);
    const row = t.devices.find((d) => !d.name.endsWith('(this device)'));
    return row?.line.startsWith('Closed') ? t : null;
  }, { timeoutMs: CONVERGE_MS, intervalMs: 1_000, label: 'A lists B as closed' });
  ctx.step(`after B quit: ${JSON.stringify(closed.devices)}`);
}

export default {
  id: 'lifecycle',
  title: 'Vault lifecycle: delete and restore, rename, separate vault, damaged copy, idle lock, Sync tab',
  scenarios: [
    { id: 'recently-deleted', title: 'Pro: a deleted entry shows in Recently deleted on both devices, is restored with its password, then erased from the shared file', run: recentlyDeleted },
    { id: 'rename-and-rebind', title: 'Pro: A renames the vault from the menu; B rebinds to the new name by itself; both keep syncing', run: renameAndRebind },
    { id: 'make-separate-vault', title: 'A same-device copy becomes a separate vault with a new lineage; the original file stays byte-for-byte the same', run: makeSeparateVault },
    { id: 'damaged-working-copy', title: 'A corrupt working copy is parked and rebuilt from the shared file at unlock', run: damagedWorkingCopy },
    { id: 'idle-auto-lock', title: 'The idle auto-lock setting persists; idle time and the screen lock lock the vault and release the lease', run: idleAutoLock },
    { id: 'settings-sync-tab', title: 'Settings > Sync shows the plan line, device limit and devices for Free and Pro', run: syncTab },
  ],
};
