// Master-password changes on a synced personal vault (docs/MULTI_DEVICE_SYNC.md 4.7, 4.8, 12 rows
// 15, 59, 65), live: a change while the other device runs, a change while it is closed with an
// unsynced edit, erasing Recently deleted with the change, and an old file that still carries the
// old password's verifier. Each scenario uses its own Vault.conduit in <cloud>/<scenario>/.

import fs from 'node:fs';
import path from 'node:path';
import { cancelUnlockDialog, entrySecrets, entrySnapshot, recentlyDeletedList, sharedGrave, sharedKeyState, unlockErrorLine } from '../lib/password-flows.mjs';
import { changeMasterPassword, cancelSettings, openSyncTool } from '../lib/settings-flows.mjs';
import { DEFERRED_PASSWORD_TEXT, EPOCH_TITLE, PASSWORD_CHANGED_TITLE, answerEpochPrompt, deferEpochPrompt, promptKinds, submitPasswordChanged, waitForPrompt } from '../lib/sync-dialogs.mjs';
import { closeRecentlyDeleted, recentlyDeletedItems } from '../lib/sync-panels.mjs';
import { createSideFileWatch, deviceUuid, openLikeIos105, sharedEntries, sideFilesNextTo, sqliteHeader } from '../lib/sync-files.mjs';
import { waitForDialog, waitForEntry } from '../lib/sync-flows.mjs';
import { clickBannerAction, waitForBanner, waitForToast } from '../lib/ui-forms.mjs';
import { snapshotSharedFile } from '../lib/vault-files.mjs';

const PW1 = 'verify-password-old-1';
const PW2 = 'verify-password-new-2';
const INVALID = 'Invalid master password';
const CHANGED_TOAST = 'Vault password changed successfully';
const RESUMED_TOAST = 'Password updated. Syncing again.';
const SUPERSEDED_TEXT = 'That is an older password. Enter the newest one.';
const CONVERGE_MS = 30_000;
// A local edit publishes 2 s after the last edit (LOCAL_EDIT_IDLE_MS); 6 s covers that and one cycle.
const PAUSED_PROOF_MS = 6_000;

const suite = { watch: null };

function vaultFor(ctx, scenario) {
  if (suite.watch === null) {
    suite.watch = createSideFileWatch(ctx.cloudDir);
    ctx.run.onCleanup('stop side-file watch', () => suite.watch?.stop());
  }
  const dir = path.join(ctx.cloudDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'Vault.conduit');
}

const scratch = (ctx) => path.join(ctx.run.runDir, 'scratch');

function waitShared(ctx, file, pred, label, timeoutMs = CONVERGE_MS) {
  return ctx.waitFor(async () => {
    const rows = sharedEntries(file, scratch(ctx));
    return pred(rows) ? rows : null;
  }, { timeoutMs, intervalMs: 500, label: `shared file: ${label}` });
}

/** Waits until the shared file's salt differs from `before`: the new password was published. */
function waitNewSalt(ctx, file, before) {
  return ctx.waitFor(async () => {
    const k = sharedKeyState(file, scratch(ctx));
    return k.salt !== before ? k : null;
  }, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'shared file: the new salt is published' });
}

const sshSeed = (s, n) => ({ name: `${s} server`, host: `10.2${n}.0.1`, port: 22, username: 'root', password: `${s}-ssh-secret-1` });
const credSeed = (s) => ({ name: `${s} login`, entry_type: 'credential', host: null, port: null, username: 'admin', password: `${s}-cred-secret-1`, totp_secret: 'JBSWY3DPEHPK3PXP' });

/** A Pro user, devices <s>a and <s>b signed in, A's new vault with `seeds`, and B unlocked on it. */
async function proPair(ctx, s, seeds) {
  const { flows } = ctx;
  const user = await ctx.createUser('pro');
  const [a, b] = await Promise.all([ctx.launchDevice(`${s}a`), ctx.launchDevice(`${s}b`)]);
  await Promise.all([flows.signIn(a, user), flows.signIn(b, user)]);
  const vault = vaultFor(ctx, s);
  await flows.createVault(a, vault, PW1);
  const entries = [];
  for (const fields of seeds) entries.push(await flows.addEntry(a, fields));
  await waitShared(ctx, vault, (rows) => entries.every((e) => rows.some((r) => r.id === e.id)), 'A published the seed entries');
  await flows.openVault(b, vault, PW1, { expect: 'unlocked' });
  await Promise.all(entries.map((e) => waitForEntry(b, e.id, (x) => x !== null, { timeoutMs: CONVERGE_MS, label: e.name })));
  ctx.step(`${a.name} and ${b.name} have ${entries.length} entries in ${path.relative(ctx.cloudDir, vault)}`);
  return { user, a, b, vault, entries };
}

async function aName(ctx, user, device) {
  const row = (await ctx.leaseRows(user.email)).find((r) => r.device_id === deviceUuid(device));
  ctx.check(row?.device_name, `${device.name} has a lease row with a device name`);
  return row.device_name;
}

/** Changes the password on `device` through Vault > Change Password... and waits for the published salt. */
async function changePassword(ctx, device, vault, opts) {
  const before = sharedKeyState(vault, scratch(ctx));
  const res = await changeMasterPassword(device, PW1, PW2, opts);
  ctx.checkEqual(res, { ok: true }, `${device.name}: Change Password accepted the change`);
  await waitForToast(device, CHANGED_TOAST);
  const after = await waitNewSalt(ctx, vault, before.salt);
  ctx.step(`${device.name} changed the password; the shared file has ${after.epochs.length} key epochs and ${after.wraps} wrap(s)`);
  return { before, after };
}

/** 4.8: two epochs, the new one current (its parent is the old one); the old verifier and salt are gone. */
function checkKeyState(ctx, k, label) {
  ctx.checkEqual(k.epochs.length, 2, `${label}: two key epochs`);
  const [old, cur] = k.epochs;
  ctx.checkEqual({ parent: cur.parent, cur: [cur.hasSalt, cur.hasVerification], old: [old.hasSalt, old.hasVerification] },
    { parent: old.epochId, cur: [true, true], old: [false, false] }, `${label}: the new epoch descends from the old one, whose salt and verifier are redacted`);
  ctx.check(k.wraps >= 1, `${label}: the new key wraps the old one`);
}

async function checkSameEverywhere(ctx, devices, ids, expectSecrets) {
  const snaps = await Promise.all(devices.map((d) => entrySnapshot(d)));
  ctx.checkEqual(snaps[1], snaps[0], `${devices[0].name} and ${devices[1].name} show identical entries`);
  for (const d of devices) ctx.checkEqual(await entrySecrets(d, ids), expectSecrets, `${d.name}: every secret decrypts to its expected value`);
}

/** Old password refused (the plain message: its verifier is gone), new password unlocks; the secrets still decrypt. */
async function checkOldRefusedNewOpens(ctx, device, vault, ids, expectSecrets) {
  const { flows } = ctx;
  await flows.lockVault(device);
  const res = await flows.openVault(device, vault, PW1);
  ctx.checkEqual({ outcome: res.outcome, error: res.outcome === 'error' ? await unlockErrorLine(device) : null }, { outcome: 'error', error: INVALID }, `${device.name}: the old password no longer unlocks`);
  ctx.check(!(await ctx.ui.invoke(device, 'vault_is_unlocked')), `${device.name} stays locked after the old password`);
  await ctx.shot(device, 'old-password-refused');
  await cancelUnlockDialog(device);
  await flows.openVault(device, vault, PW2, { expect: 'unlocked' });
  ctx.checkEqual(await entrySecrets(device, ids), expectSecrets, `${device.name}: secrets decrypt after unlocking with the new password`);
  ctx.step(`${device.name}: old password refused ("${INVALID}"), new password unlocks`);
}

/** The shared file keeps the WAL header, opens like iOS 1.0.5, and no side file appeared in this scenario's folder. */
function checkFile(ctx, vault) {
  const rel = path.relative(ctx.cloudDir, vault);
  const dir = path.dirname(rel);
  ctx.checkEqual(suite.watch.violations().filter((v) => v.file.startsWith(`${dir}${path.sep}`)), [], `${dir}: no -wal / -shm / -journal file ever appeared`);
  ctx.checkEqual(sideFilesNextTo(vault), [], `${rel}: no side files now`);
  ctx.checkEqual(sqliteHeader(vault), { magicOk: true, writeVersion: 2, readVersion: 2 }, `${rel}: SQLite header bytes 18/19 are 2/2 (WAL)`);
  ctx.checkEqual(openLikeIos105(vault, scratch(ctx)), { journalMode: 'wal', quickCheck: 'ok', schemaVersion: '10' }, `${rel}: opens like iOS 1.0.5`);
}

// ---------- P1: change while both devices are open ----------

async function changeWhileBothOpen(ctx) {
  const { flows, ui } = ctx;
  const { user, a, b, vault, entries } = await proPair(ctx, 'p1', [sshSeed('p1', 1), credSeed('p1')]);
  const [ssh, cred] = entries;
  const ids = [ssh.id, cred.id];
  const { after } = await changePassword(ctx, a, vault);
  checkKeyState(ctx, after, 'after the change on A');

  const prompt = await waitForPrompt(b, 'epoch-newer', { timeoutMs: CONVERGE_MS });
  const nameA = await aName(ctx, user, a);
  ctx.checkEqual(prompt.changedByDeviceName, nameA, 'B\'s prompt names the device that changed the password');
  const dialog = await waitForDialog(b, EPOCH_TITLE);
  ctx.check(dialog.text.includes(`The master password was changed on ${nameA}`) && dialog.text.includes('Enter the new password to keep syncing.'), `B shows "${EPOCH_TITLE}": ${dialog.text.slice(0, 300)}`);
  await ctx.shot(b, 'syncing-paused');
  await deferEpochPrompt(b);
  const banner = await waitForBanner(b, DEFERRED_PASSWORD_TEXT);
  ctx.check(banner.actions.includes('Enter password'), `the deferred banner offers [Enter password] (${JSON.stringify(banner.actions)})`);

  await flows.updateEntry(b, ssh.id, { host: '10.21.0.2' });
  await flows.updateEntry(b, cred.id, { password: 'p1-cred-secret-2' });
  ctx.step('B kept working: changed the SSH host and the credential password while syncing is paused');
  await ctx.sleep(PAUSED_PROOF_MS);
  const status = (await ui.readSyncState(b)).status;
  ctx.checkEqual(status?.kind, 'paused', `B's sync status is paused (${JSON.stringify({ kind: status?.kind, pauseReason: status?.pauseReason })})`);
  ctx.check(sharedEntries(vault, scratch(ctx)).find((r) => r.id === ssh.id)?.host === '10.21.0.1', 'B did not publish while paused');
  ctx.checkEqual((await entrySecrets(a, [cred.id]))[cred.id].password, 'p1-cred-secret-1', 'A does not have B\'s paused edit');
  await ctx.shot(b, 'paused-banner-after-edit');

  await clickBannerAction(b, DEFERRED_PASSWORD_TEXT, 'Enter password');
  ctx.checkEqual(await answerEpochPrompt(b, PW1), { ok: false, error: SUPERSEDED_TEXT }, `the old password is refused in "${EPOCH_TITLE}"`);
  ctx.checkEqual(await answerEpochPrompt(b, PW2), { ok: true }, 'B accepts the new password');
  await waitForToast(b, RESUMED_TOAST);
  const secrets = {
    [ssh.id]: { password: 'p1-ssh-secret-1', private_key: null, totp_secret: null },
    [cred.id]: { password: 'p1-cred-secret-2', private_key: null, totp_secret: 'JBSWY3DPEHPK3PXP' },
  };
  await waitForEntry(a, ssh.id, (e) => e?.host === '10.21.0.2', { timeoutMs: CONVERGE_MS, label: 'B\'s paused host edit' });
  await ctx.waitFor(async () => (await entrySecrets(a, [cred.id]))[cred.id].password === 'p1-cred-secret-2', { timeoutMs: CONVERGE_MS, label: 'B\'s paused secret edit on A' });
  ctx.step('B\'s edits made while paused reached A after the new password');
  await checkSameEverywhere(ctx, [a, b], ids, secrets);
  checkKeyState(ctx, sharedKeyState(vault, scratch(ctx)), 'after B rejoined');
  await ctx.shot(a, 'converged');

  for (const d of [a, b]) await checkOldRefusedNewOpens(ctx, d, vault, ids, secrets);
  checkFile(ctx, vault);
}

// ---------- P2: change while the other device is closed with an unsynced edit ----------

async function relaunchSignedIn(ctx, name, user) {
  const d = await ctx.launchDevice(name);
  const screen = await ctx.waitFor(async () => {
    const s = await ctx.flows.currentScreen(d);
    return s === 'auth' || s === 'hub' ? s : null;
  }, { timeoutMs: 60_000, label: `${name}: sign-in screen or hub` });
  if (screen === 'auth') await ctx.flows.signIn(d, user);
  return d;
}

async function changeWhileOtherClosed(ctx) {
  const { flows } = ctx;
  const { user, a, b, vault, entries: [ssh] } = await proPair(ctx, 'p2', [sshSeed('p2', 2)]);
  await flows.updateEntry(b, ssh.id, { host: '10.22.0.2', password: 'p2-ssh-secret-b' });
  // A normal quit runs a final sync that would publish the edit (6.4); stopping B before its 2 s
  // local-edit timer leaves the edit only in B's working copy.
  await ctx.killDevice(b);
  ctx.check(sharedEntries(vault, scratch(ctx)).find((r) => r.id === ssh.id)?.host === '10.22.0.1', 'B stopped with its edit unpublished');
  ctx.step('B edited the entry and stopped before publishing');

  const { after } = await changePassword(ctx, a, vault);
  checkKeyState(ctx, after, 'after the change on A');
  await flows.updateEntry(a, ssh.id, { port: 2202 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === ssh.id && r.port === 2202), 'A\'s edit after the change');
  const nameA = await aName(ctx, user, a);

  const b2 = await relaunchSignedIn(ctx, 'p2b', user);
  const res = await flows.openVault(b2, vault, PW1);
  // 4.8 unlock policy: the old password still opens B's own copy (its current epoch); syncing then pauses.
  ctx.checkEqual(res.outcome, 'unlocked', `B opens its own copy with the old password (${res.outcome}: ${(res.dialogs ?? []).join(', ')})`);
  const prompt = await waitForPrompt(b2, 'epoch-newer', { timeoutMs: CONVERGE_MS });
  ctx.checkEqual(prompt.changedByDeviceName, nameA, 'B\'s prompt names the device that changed the password');
  const dialog = await waitForDialog(b2, EPOCH_TITLE);
  ctx.check(dialog.text.includes(`The master password was changed on ${nameA}`), `B shows "${EPOCH_TITLE}": ${dialog.text.slice(0, 300)}`);
  await ctx.shot(b2, 'old-password-syncing-paused');
  const onB = await waitForEntry(b2, ssh.id, (e) => e !== null, { label: 'the entry' });
  ctx.checkEqual({ host: onB.host, port: onB.port }, { host: '10.22.0.2', port: 22 }, 'B keeps its own edit and has not merged A\'s');
  await ctx.sleep(PAUSED_PROOF_MS);
  ctx.check(sharedEntries(vault, scratch(ctx)).find((r) => r.id === ssh.id)?.host === '10.22.0.1', 'B does not publish under the old password');

  await flows.lockVault(b2);
  await flows.openVault(b2, vault, PW2, { expect: 'unlocked' });
  ctx.step('B unlocked with the new password');
  const secrets = { [ssh.id]: { password: 'p2-ssh-secret-b', private_key: null, totp_secret: null } };
  await Promise.all([a, b2].map((d) => waitForEntry(d, ssh.id, (e) => e?.host === '10.22.0.2' && e?.port === 2202, { timeoutMs: CONVERGE_MS, label: 'B\'s host and A\'s port merged' })));
  ctx.check(!(await promptKinds(b2)).includes('epoch-newer'), 'no password prompt after unlocking with the new password');
  await ctx.waitFor(async () => (await entrySecrets(a, [ssh.id]))[ssh.id].password === 'p2-ssh-secret-b', { timeoutMs: CONVERGE_MS, label: 'B\'s secret edit on A' });
  await checkSameEverywhere(ctx, [a, b2], [ssh.id], secrets);
  checkKeyState(ctx, sharedKeyState(vault, scratch(ctx)), 'after B rejoined');
  await ctx.shot(a, 'b-edit-kept');
  checkFile(ctx, vault);
}

// ---------- P3: the change erases Recently deleted ----------

async function eraseWithChange(ctx) {
  const { flows } = ctx;
  const doomedSeed = { ...credSeed('p3'), name: 'p3 doomed login', password: 'p3-doomed-secret' };
  const { a, b, vault, entries: [keep, doomed] } = await proPair(ctx, 'p3', [sshSeed('p3', 3), doomedSeed]);
  await flows.deleteEntry(a, doomed.id);
  await waitForEntry(b, doomed.id, (e) => e === null, { timeoutMs: CONVERGE_MS, label: 'the delete on B' });
  for (const d of [a, b]) {
    await ctx.waitFor(async () => (await recentlyDeletedList(d)).some((i) => i.title === doomed.name && !i.redacted), { timeoutMs: CONVERGE_MS, label: `${d.name}: "${doomed.name}" in Recently deleted` });
  }
  await openSyncTool(a, 'Recently deleted');
  ctx.check((await recentlyDeletedItems(a)).some((r) => r.title === doomed.name && !r.erased), 'A\'s Recently deleted panel lists the deleted login');
  await ctx.shot(a, 'recently-deleted-before');
  await closeRecentlyDeleted(a);
  await cancelSettings(a);
  ctx.checkEqual(sharedGrave(vault, scratch(ctx), doomed.id), { redacted: false, hasRowJson: true }, 'the shared file keeps the deleted login\'s grave');

  await changePassword(ctx, a, vault, { eraseRecentlyDeleted: true });
  await ctx.waitFor(() => sharedGrave(vault, scratch(ctx), doomed.id)?.redacted === true, { timeoutMs: CONVERGE_MS, label: 'the grave redacted in the shared file' });
  ctx.checkEqual(sharedGrave(vault, scratch(ctx), doomed.id), { redacted: true, hasRowJson: false }, 'the shared file no longer holds the deleted login');

  await waitForPrompt(b, 'epoch-newer', { timeoutMs: CONVERGE_MS });
  ctx.checkEqual(await answerEpochPrompt(b, PW2), { ok: true }, 'B accepts the new password');
  // The one deleted login stays listed as "Erased permanently": no title, nothing to restore.
  const erasedOnly = (items) => items.length === 1 && items[0].redacted && items[0].title === '';
  for (const d of [a, b]) {
    const items = await ctx.waitFor(async () => {
      const list = await recentlyDeletedList(d);
      return erasedOnly(list) ? list : null;
    }, { timeoutMs: CONVERGE_MS, label: `${d.name}: nothing left to restore in Recently deleted` });
    await openSyncTool(d, 'Recently deleted');
    const rows = await recentlyDeletedItems(d);
    ctx.check(rows.length === 1 && rows[0].erased && rows[0].title === '', `${d.name}: the panel shows one erased row and nothing restorable (${JSON.stringify(rows)})`);
    await ctx.shot(d, 'recently-deleted-erased');
    await closeRecentlyDeleted(d);
    await cancelSettings(d);
    ctx.step(`${d.name}: Recently deleted holds only the erased row (${JSON.stringify(items)})`);
  }
  await checkSameEverywhere(ctx, [a, b], [keep.id], { [keep.id]: { password: 'p3-ssh-secret-1', private_key: null, totp_secret: null } });
  checkFile(ctx, vault);
}

// ---------- P4: an older file still carries the old password's verifier ----------

async function olderFileOldPassword(ctx) {
  const { flows } = ctx;
  const user = await ctx.createUser('pro');
  const a = await ctx.launchDevice('p4a');
  await flows.signIn(a, user);
  const vault = vaultFor(ctx, 'p4');
  await flows.createVault(a, vault, PW1);
  const ssh = await flows.addEntry(a, sshSeed('p4', 4));
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === ssh.id), 'the entry is published');
  const oldBytes = snapshotSharedFile(vault);
  await changePassword(ctx, a, vault);
  const nameA = await aName(ctx, user, a);
  await flows.lockVault(a);

  const tmp = `${path.dirname(vault)}/.cv-rollback.part`;
  fs.writeFileSync(tmp, oldBytes);
  fs.renameSync(tmp, vault);
  ctx.step('the cloud drive brought back the file from before the change');
  const res = await flows.openVault(a, vault, PW1);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [PASSWORD_CHANGED_TITLE] }, 'the old password is refused with "Master password changed"');
  ctx.check(res.text.includes(`The master password was changed on ${nameA}`), `the dialog names the device: ${res.text.slice(0, 300)}`);
  ctx.check(!(await ctx.ui.invoke(a, 'vault_is_unlocked')), 'the vault stays locked');
  await ctx.shot(a, 'master-password-changed');
  const opened = await submitPasswordChanged(a, PW2);
  ctx.checkEqual(opened.outcome, 'unlocked', `the new password in the dialog unlocks (${opened.outcome})`);
  const k = await ctx.waitFor(async () => {
    const s = sharedKeyState(vault, scratch(ctx));
    return s.epochs.length === 2 ? s : null;
  }, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'the shared file republished under the new password' });
  checkKeyState(ctx, k, 'after the republish');
  ctx.checkEqual(await entrySecrets(a, [ssh.id]), { [ssh.id]: { password: 'p4-ssh-secret-1', private_key: null, totp_secret: null } }, 'the secret decrypts');
  checkFile(ctx, vault);
}

export default {
  id: 'password',
  title: 'Master-password changes on a synced vault',
  scenarios: [
    { id: 'change-while-both-open', title: 'Pro: A changes the password; B pauses, keeps an edit, rejoins with the new password; old password refused on both', run: changeWhileBothOpen },
    { id: 'change-while-other-closed', title: 'Pro: B stopped with an unsynced edit; A changes the password; B\'s edit is kept once it uses the new password', run: changeWhileOtherClosed },
    { id: 'erase-recently-deleted', title: 'The change with "Also permanently delete items in Recently deleted" erases graves on both devices', run: eraseWithChange },
    { id: 'older-file-old-password', title: 'A file from before the change: the old password gets "Master password changed"; the new one unlocks and republishes', run: olderFileOldPassword },
  ],
};
