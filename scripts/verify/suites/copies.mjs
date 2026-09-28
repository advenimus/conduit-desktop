// Copies of a personal vault, live (docs/MULTI_DEVICE_SYNC.md 5.5, 5.8, 5.10): a cloud drive's
// conflict copy merged automatically, a user's copy edited by desktop 0.17 reviewed first, an older
// desktop's side files pausing publishing, a mass delete undone, and two devices syncing two copies.
// Every scenario uses its own folder under <cloud>/<scenario>/ and its own device names.

import fs from 'node:fs';
import path from 'node:path';
import { createFolder, deleteFolder, legacyEditedBytes, lineageDir, listFolders, listSnapshots, presenceDevicesIn, sessionFileHints, sha256Of, sideFilesFolders, waitForStatus } from '../lib/copy-flows.mjs';
import { addNumberedEntries, entryFingerprint, openVaultHere, rowOf, scratchDir, sharedFingerprint, signedInDevices, vaultAt, waitShared } from '../lib/scenario-helpers.mjs';
import { settingsOpen, cancelSettings, openSyncTool } from '../lib/settings-flows.mjs';
import { SIDE_FILES_TEXT, TWO_COPIES_TITLE, confirmSideFilesBanner, mergeTwoCopies, waitForSideFilesBanner } from '../lib/sync-dialogs.mjs';
import { deviceUuid, sharedEntries, sideFilesNextTo } from '../lib/sync-files.mjs';
import { clickInReview, waitForDialog, waitForEntry } from '../lib/sync-flows.mjs';
import { candidatePreview, closeOtherCopies, discardCandidate, massChangeDetails, mergeCandidate, undoMassChange, waitForCopy } from '../lib/sync-panels.mjs';
import { banners, clickBannerAction, clickToastAction, toastMark, waitForBanner, waitForToast } from '../lib/ui-forms.mjs';
import { lineageIdOf, makeProviderConflictCopy, makeUserCopy, placeSideFiles, removeSideFiles } from '../lib/vault-files.mjs';

const PW = 'verify-copies-password-1';
const CONVERGE_MS = 30_000;
const NOTICE_MS = 45_000;
const SETTLE_MS = 5_000;
// The held edits reached the shared file 0.3 s after the side-files confirmation in 5 of 5 runs.
const RESUME_MS = 5_000;

const scratch = scratchDir;
const openHere = (ctx, device, file, opts) => openVaultHere(ctx, device, file, PW, opts);
const upToDate = (d) => waitForStatus(d, (s) => s.kind === 'up-to-date', { timeoutMs: CONVERGE_MS, label: 'up to date' });
const proDevices = async (ctx, names) => (await signedInDevices(ctx, 'pro', names)).devices;

// ---------- C1: a cloud drive's conflict copy with only app edits ----------

async function providerConflictCopy(ctx) {
  const { flows } = ctx;
  const [a, b, c] = await proDevices(ctx, ['c1a', 'c1b', 'c1c']);
  const vault = vaultAt(ctx, 'c1');
  await flows.createVault(a, vault, PW);
  const x = await flows.addEntry(a, { name: 'c1 server', host: '10.21.0.1', port: 22 });
  await waitShared(ctx, vault, (rows) => rowOf(rows, x.id) !== null, 'A published the entry');
  await upToDate(a);

  // Another computer of the account publishes an edit that its cloud drive then keeps as a conflict copy.
  const theirs = vaultAt(ctx, 'c1-other-computer');
  fs.copyFileSync(vault, theirs);
  await openHere(ctx, c, theirs);
  await waitForEntry(c, x.id, (e) => e !== null, { label: 'the entry on C' });
  await flows.updateEntry(c, x.id, { port: 2201 });
  await waitShared(ctx, theirs, (rows) => rowOf(rows, x.id)?.port === 2201, 'C published its edit to its own file');
  await ctx.quitDevice(c);
  ctx.checkEqual((await flows.listEntries(a)).find((e) => e.id === x.id)?.port, 22, 'A has not seen C\'s edit');

  const mark = await toastMark(a);
  const copy = makeProviderConflictCopy(vault, { style: 'dropbox', bytes: fs.readFileSync(theirs) });
  const name = path.basename(copy);
  const sha = sha256Of(copy);
  ctx.step(`conflict copy "${name}" appeared next to the shared file`);
  const t0 = Date.now();
  const toast = await waitForToast(a, 'Merged changes from a copy', { after: mark, timeoutMs: NOTICE_MS });
  ctx.step(`A merged it automatically after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${toast.title}" ${toast.message}`);
  ctx.checkEqual({ title: toast.title, message: toast.message }, { title: 'Merged changes from a copy Dropbox made.', message: `'${name}'` }, 'the toast names the provider and the copy');
  await waitForEntry(a, x.id, (e) => e?.port === 2201, { label: 'C\'s edit merged on A' });
  await waitShared(ctx, vault, (rows) => rowOf(rows, x.id)?.port === 2201, 'A published the merged edit');
  const state = (await ctx.ui.readSyncState(a)).status;
  ctx.checkEqual(state.prompts.filter((p) => p.kind === 'copy-review'), [], 'A asks nothing about the copy');
  ctx.checkEqual(state.otherCopies.filter((o) => o.name === name), [], 'A no longer lists the merged copy');
  ctx.checkEqual(sha256Of(copy), sha, 'the copy is still in place, unchanged');
  await ctx.shot(a, 'provider-copy-merged');

  await openHere(ctx, b, vault);
  await waitForEntry(b, x.id, (e) => e?.port === 2201, { label: 'the copy\'s edit on B' });
  ctx.step('B opened the shared file and has the edit from the copy');
  await openSyncTool(b, 'Other copies');
  const row = await waitForCopy(b, name);
  ctx.checkEqual({ text: row.text, actions: row.actions }, { text: 'Nothing new. Everything in it is already in your vault.', actions: ['Move to Trash', 'Ignore'] }, 'B lists the copy as nothing new, with [Move to Trash]');
  await ctx.shot(b, 'other-copies');
  await closeOtherCopies(b);
  if (await settingsOpen(b)) await cancelSettings(b);
  ctx.checkEqual(sha256Of(copy), sha, 'the copy is still in place after B\'s scan (nothing is moved without a click)');
}

// ---------- C2: a user's copy edited by an older app ----------

const COPY_NOTICE = /^'Vault 2\.conduit' is a copy of this vault with /;
const REPLICA_PREVIEW_TEXT = 'Merging applies the changes in this copy. Where your vault changed the same item since, you review both versions.';

async function expectUnchanged(ctx, devices, vault, baseline, why) {
  for (const d of devices) ctx.checkEqual(await entryFingerprint(ctx, d), baseline.devices, `${d.name}: nothing changed ${why}`);
  ctx.checkEqual(sharedFingerprint(ctx, vault), baseline.shared, `the shared file is unchanged ${why}`);
}

/** Makes "Vault 2.conduit" edited by desktop 0.17 (after removing the previous one) and waits for A's notice. */
async function legacyUserCopy(ctx, a, vault, legacy, round) {
  const target = path.join(path.dirname(vault), 'Vault 2.conduit');
  fs.rmSync(target, { force: true });
  const copy = makeUserCopy(vault, { bytes: legacyEditedBytes(vault, scratch(ctx), legacy) });
  const t0 = Date.now();
  const banner = await waitForBanner(a, COPY_NOTICE, { timeoutMs: NOTICE_MS });
  ctx.step(`round ${round}: notice after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${banner.text}"`);
  ctx.checkEqual(banner, {
    text: '\'Vault 2.conduit\' is a copy of this vault with 4 changes that aren\'t in your vault, including 3 deletions.',
    actions: ['Review...', 'Ignore this copy'],
  }, 'the notice counts 1 change and 3 deletions');
  return { copy, sha: sha256Of(copy) };
}

async function reviewCopy(ctx, a, names) {
  await clickBannerAction(a, COPY_NOTICE, 'Review...');
  const preview = await candidatePreview(a);
  ctx.checkEqual({ title: preview.title, sections: preview.sections }, { title: 'Merge \'Vault 2.conduit\'?', sections: { 'Different values': 1, 'Deleted in this copy': 3 } }, 'the preview lists 1 changed field and 3 deletions');
  for (const n of names.deleted) ctx.check(preview.text.includes(n), `the preview names the deleted "${n}"`);
  ctx.check(preview.text.includes(`${names.changed} Host: 10.22.0.4 in the vault, 10.22.9.9 in the copy`), 'the preview shows the changed host');
  ctx.check(preview.text.includes(REPLICA_PREVIEW_TEXT), 'the preview says Merge applies the copy\'s changes and deletions');
  return preview;
}

async function userCopyReview(ctx) {
  const { flows } = ctx;
  const [a, b] = await proDevices(ctx, ['c2a', 'c2b']);
  const vault = vaultAt(ctx, 'c2');
  await flows.createVault(a, vault, PW);
  const made = await addNumberedEntries(ctx, a, 'c2 server', '10.22.0', 5);
  await waitShared(ctx, vault, (rows) => made.every((m) => rowOf(rows, m.id)), 'the five entries are published');
  await openHere(ctx, b, vault);
  await Promise.all(made.map((m) => waitForEntry(b, m.id, (e) => e !== null, { label: m.name })));
  await Promise.all([upToDate(a), upToDate(b)]);
  const [d1, d2, d3, edited, kept] = made;
  const legacy = { deletes: [d1.id, d2.id, d3.id], patches: { [edited.id]: { host: '10.22.9.9' } } };
  const names = { deleted: [d1.name, d2.name, d3.name], changed: edited.name };
  const baseline = { devices: await entryFingerprint(ctx, a), shared: sharedFingerprint(ctx, vault) };
  ctx.checkEqual(await entryFingerprint(ctx, b), baseline.devices, 'A and B hold the same vault');

  const first = await legacyUserCopy(ctx, a, vault, legacy, 1);
  await ctx.sleep(SETTLE_MS);
  await expectUnchanged(ctx, [a, b], vault, baseline, 'while the notice is up (not merged automatically)');
  await ctx.shot(a, 'copy-notice');
  await clickBannerAction(a, COPY_NOTICE, 'Ignore this copy');
  await ctx.waitFor(async () => !(await banners(a)).some((x) => COPY_NOTICE.test(x.text)), { timeoutMs: 10_000, label: 'A: notice gone after [Ignore this copy]' });
  await ctx.sleep(SETTLE_MS);
  await expectUnchanged(ctx, [a, b], vault, baseline, 'after [Ignore this copy]');
  ctx.checkEqual(sha256Of(first.copy), first.sha, 'the ignored copy is still in place');

  const second = await legacyUserCopy(ctx, a, vault, legacy, 2);
  ctx.check(second.sha !== first.sha, 'the second copy has new bytes');
  await reviewCopy(ctx, a, names);
  await ctx.shot(a, 'copy-preview');
  let mark = await toastMark(a);
  await discardCandidate(a);
  await waitForToast(a, 'Copy set aside. Nothing was merged.', { after: mark });
  await ctx.sleep(SETTLE_MS);
  await expectUnchanged(ctx, [a, b], vault, baseline, 'after [Don\'t merge]');
  ctx.checkEqual(sha256Of(second.copy), second.sha, 'the copy set aside is still in place');

  await legacyUserCopy(ctx, a, vault, legacy, 3);
  await reviewCopy(ctx, a, names);
  await flows.updateEntry(b, d3.id, { host: '10.22.3.33' });
  await waitForEntry(a, d3.id, (e) => e?.host === '10.22.3.33', { label: 'B changed an item the copy deletes while the preview is open' });
  mark = await toastMark(a);
  await mergeCandidate(a);
  const merged = await waitForToast(a, /^Merged\./, { after: mark });
  ctx.checkEqual(merged.title, 'Merged. 1 change to review.', 'only the deletion of an item changed since is left to review');
  const kinds = (await ctx.ui.invoke(a, 'sync_list_conflicts', {})).flatMap((g) => g.items.map((i) => i.kind));
  ctx.checkEqual(kinds, ['edit-delete'], 'the review item is the deleted-and-edited one');
  const landed = (rows) => [d1, d2].every((m) => !rowOf(rows, m.id)) && rowOf(rows, d3.id)?.host === '10.22.3.33' &&
    rowOf(rows, edited.id)?.host === '10.22.9.9' && rowOf(rows, kept.id)?.host === kept.host;
  for (const d of [a, b]) {
    await ctx.waitFor(async () => landed(await flows.listEntries(d)), { timeoutMs: CONVERGE_MS, label: `${d.name}: the copy's edit and two deletions landed` });
  }
  await waitShared(ctx, vault, landed, 'the merged changes are published');
  await ctx.shot(a, 'copy-merged-review');
  await ctx.flows.openConflictReview(a);
  await clickInReview(a, 'Keep item');
  await ctx.waitFor(async () => (await ctx.ui.invoke(a, 'sync_list_conflicts', {})).length === 0, { timeoutMs: CONVERGE_MS, label: 'A: review empty after [Keep item]' });
  await waitForEntry(b, d3.id, (e) => e?.host === '10.22.3.33', { label: 'the kept item on B' });
  const deleted = (await ctx.ui.invoke(a, 'sync_recently_deleted', { showAll: false })).map((i) => i.title).sort();
  ctx.checkEqual(deleted, [d1.name, d2.name], 'the merged deletions can be restored from Recently deleted');
  await ctx.shot(a, 'copy-merged');
}

// ---------- C3: an older desktop's side files pause publishing ----------

async function sideFilesPause(ctx) {
  const { flows } = ctx;
  const [a, b] = await proDevices(ctx, ['c3a', 'c3b']);
  const vault = vaultAt(ctx, 'c3');
  ctx.onClose('remove c3 side files', () => removeSideFiles(vault));
  await flows.createVault(a, vault, PW);
  const x = await flows.addEntry(a, { name: 'c3 server', host: '10.23.0.1', port: 22 });
  await waitShared(ctx, vault, (rows) => rowOf(rows, x.id) !== null, 'the entry is published');
  await openHere(ctx, b, vault);
  await waitForEntry(b, x.id, (e) => e !== null, { label: 'the entry on B' });
  await Promise.all([upToDate(a), upToDate(b)]);
  let t0 = Date.now();
  await flows.updateEntry(a, x.id, { port: 2301 });
  await waitShared(ctx, vault, (rows) => rowOf(rows, x.id)?.port === 2301, 'a normal edit is published');
  const publishMs = Date.now() - t0;
  ctx.step(`a normal edit reached the shared file in ${(publishMs / 1000).toFixed(1)} s`);
  await waitForEntry(b, x.id, (e) => e?.port === 2301, { label: 'the normal edit on B' });

  placeSideFiles(vault);
  ctx.step(`an older desktop "opened" the vault: ${sideFilesNextTo(vault).join(', ')}`);
  const shown = await Promise.all([a, b].map((d) => waitForSideFilesBanner(d)));
  for (const s of shown) {
    ctx.checkEqual(s, {
      text: 'An older version of Conduit may have this vault open on another computer. Update or close it there to sync safely. Your changes are saved on this device.',
      actions: ['Conduit is closed on my other computers'],
    }, 'the side-files banner and its button');
  }
  await ctx.shot(a, 'side-files-banner');

  const y = await flows.addEntry(a, { name: 'c3 held', host: '10.23.0.2', port: 22 });
  await flows.updateEntry(a, x.id, { host: '10.23.9.9' });
  const onA = await flows.listEntries(a);
  ctx.check(rowOf(onA, y.id) !== null && rowOf(onA, x.id)?.host === '10.23.9.9', 'local edits keep working on A');
  const paused = await waitForStatus(a, (s) => s.kind === 'paused' && s.pauseReason === 'side-files' && s.pendingPublish, { label: 'A paused for side files with changes pending' });
  const holdMs = Math.max(10_000, 3 * publishMs);
  await ctx.sleep(holdMs);
  const shared = sharedEntries(vault, scratch(ctx));
  ctx.check(rowOf(shared, y.id) === null && rowOf(shared, x.id)?.host === '10.23.0.1', `nothing is published for ${holdMs / 1000} s (${JSON.stringify(shared)})`);
  const onB = await flows.listEntries(b);
  ctx.check(rowOf(onB, y.id) === null && rowOf(onB, x.id)?.host === '10.23.0.1', 'B has not received the held edits');
  await waitForStatus(a, (s) => s.kind === 'paused' && s.pendingPublish, { label: 'A still paused with changes pending' });
  ctx.step(`A held ${paused.unsyncedOps} change(s) while paused`);
  await ctx.shot(a, 'paused-with-held-edits');
  ctx.checkEqual(sideFilesNextTo(vault).sort(), ['Vault.conduit-shm', 'Vault.conduit-wal'], 'the side files are untouched while paused');

  const mark = await toastMark(a);
  t0 = Date.now();
  const label = await confirmSideFilesBanner(a);
  ctx.checkEqual(label, 'Conduit is closed on my other computers', 'the confirm button');
  await waitForToast(a, 'Syncing resumed.', { after: mark });
  const resumed = await waitForStatus(a, () => true, { label: 'A status after the confirmation' });
  ctx.step(`A status right after the confirmation: ${resumed.kind}${resumed.pauseReason ? ` (${resumed.pauseReason})` : ''}`);
  ctx.checkEqual(sideFilesNextTo(vault), [], 'the side files left the cloud folder');
  const lineage = lineageIdOf(vault, scratch(ctx));
  const folders = sideFilesFolders(a, lineage);
  ctx.checkEqual(folders.map((f) => f.files), [[{ name: 'Vault.conduit-shm', size: 32_768 }, { name: 'Vault.conduit-wal', size: 0 }]], `moved aside, not deleted, into ${path.relative(ctx.run.tmpRoot, lineageDir(a, lineage))}/${folders[0]?.name}`);
  await waitShared(ctx, vault, (rows) => rowOf(rows, y.id) !== null && rowOf(rows, x.id)?.host === '10.23.9.9', 'publishing resumed', RESUME_MS);
  ctx.step(`the held edits reached the shared file ${((Date.now() - t0) / 1000).toFixed(1)} s after the confirmation`);
  await waitForEntry(b, y.id, (e) => e !== null, { label: 'the held new entry on B' });
  await waitForEntry(b, x.id, (e) => e?.host === '10.23.9.9', { label: 'the held edit on B' });
  for (const d of [a, b]) {
    await ctx.waitFor(async () => !(await banners(d)).some((s) => SIDE_FILES_TEXT.test(s.text)), { timeoutMs: CONVERGE_MS, label: `${d.name}: side-files banner gone` });
  }
  await ctx.shot(b, 'held-edits-received');
}

// ---------- C4: a mass delete merged, then undone ----------

async function massDeleteUndo(ctx) {
  const { flows } = ctx;
  const [a, b] = await proDevices(ctx, ['c4a', 'c4b']);
  const vault = vaultAt(ctx, 'c4');
  await flows.createVault(a, vault, PW);
  const folder = await createFolder(a, 'c4 batch');
  const batch = await addNumberedEntries(ctx, a, 'c4 batch', '10.24.1', 12, { folder_id: folder.id });
  const other = await flows.addEntry(a, { name: 'c4 other', host: '10.24.0.1', port: 22 });
  const gone = await flows.addEntry(a, { name: 'c4 gone', host: '10.24.0.2', port: 22 });
  await waitShared(ctx, vault, (rows) => rows.length === 14, 'the 14 entries are published');
  await openHere(ctx, b, vault);
  await ctx.waitFor(async () => (await flows.listEntries(b)).length === 14, { timeoutMs: CONVERGE_MS, label: 'B has the 14 entries' });
  await Promise.all([upToDate(a), upToDate(b)]);

  await flows.deleteEntry(a, gone.id);
  await waitForEntry(b, gone.id, (e) => e === null, { label: 'a single delete reached B' });
  ctx.checkEqual(await listSnapshots(b), [], 'a single delete takes no snapshot');

  const mark = await toastMark(b);
  await deleteFolder(a, folder.id);
  ctx.step('A deleted folder "c4 batch" with its 12 entries');
  const t0 = Date.now();
  const notice = await waitForToast(b, /^A sync from another device deleted or changed/, { after: mark, timeoutMs: NOTICE_MS });
  ctx.step(`B merged it and showed "${notice.title}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  ctx.checkEqual({ title: notice.title, actions: notice.actions }, { title: 'A sync from another device deleted or changed 13 items.', actions: ['Review'] }, 'the mass-change notice (12 entries and their folder)');
  const onB = await flows.listEntries(b);
  ctx.check(batch.every((e) => !rowOf(onB, e.id)) && rowOf(onB, other.id), 'B applied the delete (shared-file merges are never blocked)');
  const snaps = await listSnapshots(b);
  ctx.checkEqual(snaps.map((s) => ({ deleted: s.deleted, changedRows: s.changedRows })), [{ deleted: 13, changedRows: 0 }], 'B took one pre-merge snapshot');
  const lineage = lineageIdOf(vault, scratch(ctx));
  const onDisk = fs.readdirSync(path.join(lineageDir(b, lineage), 'snapshots'));
  ctx.check(onDisk.some((n) => n.startsWith(snaps[0].id)), `the snapshot is on disk (${onDisk.join(', ')})`);

  await flows.updateEntry(a, other.id, { host: '10.24.9.9' });
  await waitForEntry(b, other.id, (e) => e?.host === '10.24.9.9', { label: 'A\'s later unrelated edit on B' });

  await clickToastAction(b, 'A sync from another device deleted', 'Review');
  const det = await massChangeDetails(b);
  ctx.check(/ deleted 13 items\.$/.test(det.title), `dialog title "${det.title}"`);
  ctx.checkEqual(det.rows.map((r) => r.title).sort(), ['c4 batch', ...batch.map((e) => e.name)].sort(), 'Undo lists exactly the folder and its 12 entries');
  ctx.check(det.rows.every((r) => r.checked && !r.disabled), 'every row is pre-selected');
  ctx.check(!det.text.includes('Changed fields'), 'no changed fields are offered');
  await ctx.shot(b, 'mass-change-undo');
  const markUndo = await toastMark(b);
  await undoMassChange(b);
  const undone = await waitForToast(b, /^Undid /, { after: markUndo });
  ctx.checkEqual(undone.title, 'Undid 13 changes.', 'the undo toast');

  const expected = (rows) => batch.every((e, i) => rowOf(rows, e.id)?.host === `10.24.1.${i + 1}` && rowOf(rows, e.id)?.folder_id === folder.id) &&
    rowOf(rows, other.id)?.host === '10.24.9.9' && rowOf(rows, gone.id) === null && rows.length === 13;
  for (const d of [b, a]) {
    const rows = await ctx.waitFor(async () => {
      const r = await flows.listEntries(d);
      return expected(r) ? r : null;
    }, { timeoutMs: CONVERGE_MS, label: `${d.name}: exactly the 12 entries back, the later edit kept, the single delete kept` });
    ctx.check((await listFolders(d)).some((f) => f.id === folder.id), `${d.name}: the folder is back`);
    ctx.step(`${d.name}: ${rows.length} entries after the undo`);
  }
  await waitShared(ctx, vault, (rows) => rows.length === 13 && rowOf(rows, other.id)?.host === '10.24.9.9', 'the undo is published');
}

// ---------- C5: two devices bound to two copies ----------

const TWO_COPIES_TEXT = /syncs 'Vault\.conduit' in (Dropbox|OneDrive)\. This computer syncs 'Vault\.conduit' in (OneDrive|Dropbox)\. These are separate copies and they aren't syncing with each other\./;

async function expectTwoCopiesPrompt(ctx, device, other, ours, theirs) {
  const t0 = Date.now();
  const dialog = await waitForDialog(device, TWO_COPIES_TITLE, { timeoutMs: 120_000 });
  ctx.step(`${device.name}: "${TWO_COPIES_TITLE}" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const m = dialog.text.match(TWO_COPIES_TEXT);
  ctx.checkEqual(m ? [m[1], m[2]] : null, [theirs, ours], `${device.name}: the prompt names both providers`);
  const prompt = (await ctx.ui.readSyncState(device)).status.prompts.find((p) => p.kind === 'different-copies');
  ctx.checkEqual({ device: prompt?.deviceUuid, theirs: prompt?.theirs.location, ours: prompt?.ours.location },
    { device: deviceUuid(other), theirs: `${theirs.toLowerCase()}:${theirs}`, ours: `${ours.toLowerCase()}:${ours}` }, `${device.name}: the prompt comes from the other device's file hint`);
}

async function mergeOtherCopy(ctx, device, otherFile) {
  await mergeTwoCopies(device, otherFile);
  const preview = await candidatePreview(device);
  ctx.checkEqual({ title: preview.title, sections: preview.sections }, { title: 'Merge \'Vault.conduit\'?', sections: { 'Different values': 1 } }, `${device.name}: the other copy's one change is previewed`);
  const mark = await toastMark(device);
  await mergeCandidate(device);
  await waitForToast(device, /^Merged\./, { after: mark });
}

async function differentCopies(ctx) {
  const { flows } = ctx;
  const { user, devices: [a, b] } = await signedInDevices(ctx, 'pro', ['c5a', 'c5b']);
  const dropbox = vaultAt(ctx, 'c5', 'Dropbox');
  const onedrive = vaultAt(ctx, 'c5', 'OneDrive');
  await flows.createVault(a, dropbox, PW);
  const [x, y] = await addNumberedEntries(ctx, a, 'c5 server', '10.25.0', 2);
  await waitShared(ctx, dropbox, (rows) => rows.length === 2, 'the entries are published');
  await upToDate(a);
  fs.copyFileSync(dropbox, onedrive);
  ctx.step('the vault was copied from Dropbox to OneDrive');
  const opened = await openHere(ctx, b, onedrive, { promptAtUnlock: TWO_COPIES_TITLE });
  ctx.step(`B unlocked the OneDrive copy${opened.dialogs ? ` and at once showed "${opened.dialogs.join(', ')}"` : ''}`);
  await waitForEntry(b, y.id, (e) => e !== null, { label: 'the entries on B' });
  ctx.checkEqual(lineageIdOf(onedrive, scratch(ctx)), lineageIdOf(dropbox, scratch(ctx)), 'both copies hold the same lineage');

  await flows.updateEntry(a, x.id, { host: '10.25.1.1' });
  await flows.updateEntry(b, y.id, { port: 2502 });
  await waitShared(ctx, dropbox, (rows) => rowOf(rows, x.id)?.host === '10.25.1.1', 'A\'s edit in the Dropbox copy');
  await waitShared(ctx, onedrive, (rows) => rowOf(rows, y.id)?.port === 2502, 'B\'s edit in the OneDrive copy');

  await expectTwoCopiesPrompt(ctx, b, a, 'OneDrive', 'Dropbox');
  await ctx.shot(b, 'two-copies');
  const [ua, ub] = [deviceUuid(a), deviceUuid(b)];
  ctx.check(!presenceDevicesIn(dropbox, scratch(ctx)).includes(ub), 'A\'s copy never carried B\'s presence, so only B\'s session row can tell A');
  const hints = Object.fromEntries((await sessionFileHints(ctx, user.email)).map((r) => [r.device_id, [r.file_id, r.location, r.file_name]]));
  ctx.check(hints[ua]?.[0] && hints[ua][0] === hints[ub]?.[0], `both session rows carry the same file_id (${JSON.stringify(hints)})`);
  ctx.checkEqual([hints[ua].slice(1), hints[ub].slice(1)], [['dropbox:Dropbox', 'Vault.conduit'], ['onedrive:OneDrive', 'Vault.conduit']], 'the session rows name each device\'s copy');
  await expectTwoCopiesPrompt(ctx, a, b, 'Dropbox', 'OneDrive');
  await ctx.shot(a, 'two-copies');

  await mergeOtherCopy(ctx, b, dropbox);
  await waitForEntry(b, x.id, (e) => e?.host === '10.25.1.1', { label: 'A\'s edit merged on B' });
  await waitShared(ctx, onedrive, (rows) => rowOf(rows, x.id)?.host === '10.25.1.1' && rowOf(rows, y.id)?.port === 2502, 'B published both edits to its copy');
  await mergeOtherCopy(ctx, a, onedrive);
  await waitForEntry(a, y.id, (e) => e?.port === 2502, { label: 'B\'s edit merged on A' });
  await waitShared(ctx, dropbox, (rows) => rowOf(rows, x.id)?.host === '10.25.1.1' && rowOf(rows, y.id)?.port === 2502, 'A published both edits to its copy');
  await ctx.shot(a, 'copies-merged');
}

export default {
  id: 'copies',
  title: 'Copies of a personal vault: conflict copies, user copies, side files, mass change, two copies',
  scenarios: [
    { id: 'provider-conflict-copy', title: 'Pro: a cloud drive conflict copy with only app edits is merged automatically and left in place', run: providerConflictCopy },
    { id: 'user-copy-review', title: 'A user copy edited by an older app asks first: ignore and don\'t merge change nothing, merge applies it', run: userCopyReview },
    { id: 'side-files-pause', title: 'Side files of an older desktop pause publishing until confirmed; they are moved aside and held edits sync', run: sideFilesPause },
    { id: 'mass-delete-undo', title: 'Pro: a merged folder delete of 12 entries is snapshotted, and Undo restores exactly those rows', run: massDeleteUndo },
    { id: 'different-copies', title: 'Pro: two devices on two copies (Dropbox, OneDrive) get the two-copies prompt and merge them', run: differentCopies },
  ],
};
