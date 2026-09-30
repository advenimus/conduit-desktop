// Personal vault sync and device leases (docs/MULTI_DEVICE_SYNC.md sections 5, 6 and 7), live:
// Free take-over and take-back, Pro merge and conflict review, plan changes, sign-out release,
// signed-out owner claims, a desktop 0.17 style legacy edit, and file safety of the shared file.
// Each scenario uses its own Vault.conduit in <cloud>/<scenario>/.

import fs from 'node:fs';
import path from 'node:path';
import {
  createSideFileWatch,
  deviceUuid,
  legacyEditInPlace,
  openLikeIos105,
  sharedEntries,
  sideFilesNextTo,
  sqliteHeader,
} from '../lib/sync-files.mjs';
import {
  TAKEOVER_TITLE,
  bodyText,
  clickInReview,
  conflictCount,
  dialogDetails,
  displacedShown,
  listConflicts,
  useHereFromDisplaced,
  useHereFromTakeover,
  useVersionInReview,
  waitForDisplaced,
  waitForEntry,
  waitForEntryInUi,
} from '../lib/sync-flows.mjs';

const PW = 'verify-sync-password-1';
const TAKEOVER_DISPLACED_MS = 35_000;
const CONVERGE_MS = 30_000;
const PLAN_CHANGE_MS = 40_000;
const RELEASE_MS = 5_000;
const CLAIM_DISPLACED_MS = 60_000;

// Suite-wide state for the file-safety scenario: the side-file watch on the cloud folder and every
// Vault.conduit this suite created.
const suite = { watch: null, vaults: new Set() };

function startFileWatch(ctx) {
  if (suite.watch !== null) return;
  suite.watch = createSideFileWatch(ctx.cloudDir);
  ctx.run.onCleanup('stop side-file watch', () => suite.watch?.stop());
}

function vaultFor(ctx, scenario) {
  startFileWatch(ctx);
  const dir = path.join(ctx.cloudDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Vault.conduit');
  suite.vaults.add(file);
  return file;
}

const scratch = (ctx) => path.join(ctx.run.runDir, 'scratch');

/** Device roots persist per name within a run, so every scenario launches its own names (s1a, s1b, ...). */
function launchPair(ctx, scenario) {
  return Promise.all([ctx.launchDevice(`${scenario}a`), ctx.launchDevice(`${scenario}b`)]);
}

async function signedInPair(ctx, role, scenario) {
  const user = await ctx.createUser(role);
  ctx.step(`created ${role} user ${user.email}`);
  const [a, b] = await launchPair(ctx, scenario);
  const [whoA, whoB] = await Promise.all([ctx.flows.signIn(a, user), ctx.flows.signIn(b, user)]);
  ctx.checkEqual([whoA.tier, whoB.tier], [role, role], `both devices signed in on the ${role} plan`);
  return { user, a, b };
}

/** Waits until the shared file (read through a private copy) satisfies `pred(entries)`. */
function waitShared(ctx, file, pred, label, timeoutMs = CONVERGE_MS) {
  return ctx.waitFor(async () => {
    if (!fs.existsSync(file)) return null;
    const rows = sharedEntries(file, scratch(ctx));
    return pred(rows) ? rows : null;
  }, { timeoutMs, intervalMs: 500, label: `shared file: ${label}` });
}

async function leaseByDevice(ctx, email) {
  const rows = await ctx.leaseRows(email);
  return new Map(rows.map((r) => [r.device_id, r]));
}

/** Waits until the lease rows of `email` match `expect` ({deviceUuid: fields}); returns them. */
function waitLeases(ctx, email, expect, { timeoutMs = 10_000, label = 'lease rows' } = {}) {
  let last = null;
  return ctx.waitFor(async () => {
    last = await leaseByDevice(ctx, email);
    const ok = Object.entries(expect).every(([id, fields]) => {
      const row = last.get(id);
      return row && Object.entries(fields).every(([k, v]) => row[k] === v);
    });
    return ok ? last : null;
  }, { timeoutMs, label: `${label} ${JSON.stringify(expect)} (last: ${JSON.stringify(last ? [...last.values()].map((r) => [r.device_id.slice(0, 8), r.status, r.displaced_reason]) : null)})` });
}

async function expectNoSyncDialogs(ctx, device, why) {
  const dialogs = (await dialogDetails(device)).map((d) => d.title);
  ctx.checkEqual(dialogs, [], `${device.name}: no dialog ${why}`);
}

async function waitConflictCount(ctx, device, n, timeoutMs = CONVERGE_MS) {
  return ctx.waitFor(async () => (await conflictCount(device)) === n, { timeoutMs, intervalMs: 500, label: `${device.name}: ${n} conflict(s)` });
}

// ---------- S1, S2: Free take-over and take-back ----------

/** S1: A creates the vault with an SSH entry; B takes it over through the server lease denial. */
async function freeTakeover(ctx, scenario) {
  const { flows } = ctx;
  const { user, a, b } = await signedInPair(ctx, 'free', scenario);
  const vault = vaultFor(ctx, scenario);
  await flows.createVault(a, vault, PW);
  const entry = await flows.addEntry(a, { name: `${scenario} server`, host: '10.1.0.1', port: 22 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id), 'A published the new entry');
  const [ua, ub] = [deviceUuid(a), deviceUuid(b)];
  await waitLeases(ctx, user.email, { [ua]: { status: 'active' } }, { label: 'A holds the lease' });
  await ctx.shot(a, 'vault-with-entry');

  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [TAKEOVER_TITLE] }, 'B is offered a take-over');
  ctx.check(res.text.includes('On the Free plan a vault can be open on one device at a time.'), 'the take-over dialog names the Free rule');
  await ctx.shot(b, 'takeover-dialog');

  const t0 = Date.now();
  const opened = await useHereFromTakeover(b);
  ctx.step(`B unlocked after take-over${opened.waited ? ' (waited for the drive)' : ''}`);
  const onB = await waitForEntry(b, entry.id, (e) => e !== null, { label: 'the SSH entry from A' });
  ctx.checkEqual({ host: onB.host, port: onB.port }, { host: '10.1.0.1', port: 22 }, 'B has A\'s entry');
  await waitForEntryInUi(b, entry.name);
  await ctx.shot(b, 'opened-with-entry');

  const displaced = await waitForDisplaced(a, { timeoutMs: TAKEOVER_DISPLACED_MS - (Date.now() - t0) });
  ctx.step(`A displaced after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${displaced.title}"`);
  ctx.check(displaced.text.includes('This vault is now open on'), `A's modal is the take-over text: ${displaced.text.slice(0, 200)}`);
  ctx.check(displaced.text.includes('Use here instead'), 'A is offered [Use here instead]');
  await ctx.shot(a, 'displaced-modal');
  const leases = await waitLeases(ctx, user.email, {
    [ua]: { status: 'displaced', displaced_reason: 'takeover', displaced_by_device: ub },
    [ub]: { status: 'active' },
  }, { label: 'after take-over' });
  // B's first lease: A never saw B in a sessions list before, so the name comes from the server.
  ctx.checkEqual(displaced.title, `Opened on ${leases.get(ub).device_name}`, 'A\'s modal names the device that took the vault over');
  return { user, a, b, ua, ub, vault, entry };
}

async function freeTakeoverScenario(ctx) {
  await freeTakeover(ctx, 's1');
}

/** S2: from A's displaced modal, [Use here instead] takes the vault back; B is displaced. */
async function takeBack(ctx) {
  const { user, a, b, ua, ub, entry } = await freeTakeover(ctx, 's2');
  const t0 = Date.now();
  const res = await useHereFromDisplaced(a, PW);
  ctx.checkEqual(res.outcome, 'unlocked', `A reopens from the displaced modal (${res.dialogs?.join(', ') ?? ''})`);
  await waitForEntry(a, entry.id, (e) => e !== null, { label: 'the entry after take-back' });
  await ctx.shot(a, 'reopened');
  const displaced = await waitForDisplaced(b, { timeoutMs: TAKEOVER_DISPLACED_MS });
  ctx.step(`B displaced after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${displaced.title}"`);
  ctx.check(displaced.text.includes('This vault is now open on'), `B's modal is the take-over text: ${displaced.text.slice(0, 200)}`);
  await ctx.shot(b, 'displaced-modal');
  const leases = await waitLeases(ctx, user.email, {
    [ua]: { status: 'active' },
    [ub]: { status: 'displaced', displaced_reason: 'takeover', displaced_by_device: ua },
  }, { label: 'after take-back' });
  ctx.checkEqual(displaced.title, `Opened on ${leases.get(ua).device_name}`, 'B\'s modal names the device that took the vault back');
}

// ---------- S3: Pro merge and conflicts ----------

async function openProPair(ctx, scenario, entryFields) {
  const { flows } = ctx;
  const { user, a, b } = await signedInPair(ctx, 'pro', scenario);
  const vault = vaultFor(ctx, scenario);
  await flows.createVault(a, vault, PW);
  const entry = entryFields ? await flows.addEntry(a, entryFields) : null;
  if (entry) await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id), 'A published the new entry');
  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual(res.outcome, 'unlocked', `B opens the Pro vault at once (${res.dialogs?.join(', ') ?? ''})`);
  await expectNoSyncDialogs(ctx, a, 'on A after B opened');
  const [ua, ub] = [deviceUuid(a), deviceUuid(b)];
  await waitLeases(ctx, user.email, { [ua]: { status: 'active' }, [ub]: { status: 'active' } }, { label: 'both Pro devices hold a lease' });
  return { user, a, b, ua, ub, vault, entry };
}

async function waitBoth(ctx, devices, id, pred, label) {
  return Promise.all(devices.map((d) => waitForEntry(d, id, pred, { timeoutMs: CONVERGE_MS, label })));
}

async function proMergeAndConflict(ctx) {
  const { flows } = ctx;
  const { a, b, entry } = await openProPair(ctx, 's3', { name: 's3 server', host: '10.3.0.1', port: 22 });
  const both = [a, b];

  await Promise.all([flows.updateEntry(a, entry.id, { host: '10.3.0.2' }), flows.updateEntry(b, entry.id, { port: 2222 })]);
  await waitBoth(ctx, both, entry.id, (e) => e?.host === '10.3.0.2' && e?.port === 2222, 'A\'s host and B\'s port merged');
  ctx.checkEqual([await conflictCount(a), await conflictCount(b)], [0, 0], 'different fields merge without a conflict');
  ctx.step('A\'s host edit and B\'s port edit converged on both devices');

  await Promise.all([flows.updateEntry(a, entry.id, { host: '10.3.0.100' }), flows.updateEntry(b, entry.id, { host: '10.3.0.200' })]);
  await Promise.all(both.map((d) => waitConflictCount(ctx, d, 1)));
  for (const d of both) await ctx.waitFor(async () => (await bodyText(d)).includes('1 change from your other devices needs review.'), { timeoutMs: 10_000, label: `${d.name}: review banner` });
  await ctx.shot(a, 'conflict-banner');
  await ctx.shot(b, 'conflict-banner');

  await flows.openConflictReview(a);
  await ctx.shot(a, 'review-panel');
  await useVersionInReview(a, 'Host', '10.3.0.100');
  await Promise.all(both.map((d) => waitConflictCount(ctx, d, 0)));
  await waitBoth(ctx, both, entry.id, (e) => e?.host === '10.3.0.100', 'A\'s resolved host');
  ctx.step('conflict resolved on A; both devices show A\'s host');
  await ctx.shot(b, 'resolved');

  await Promise.all([flows.deleteEntry(a, entry.id), flows.updateEntry(b, entry.id, { host: '10.3.0.201' })]);
  const kinds = async (d) => (await listConflicts(d)).flatMap((g) => g.items.map((i) => i.kind));
  await Promise.all(both.map((d) => ctx.waitFor(async () => (await kinds(d)).includes('edit-delete'), { timeoutMs: CONVERGE_MS, intervalMs: 500, label: `${d.name}: an edit-delete conflict` })));
  const reviewer = b;
  await flows.openConflictReview(reviewer);
  await ctx.waitFor(async () => (await bodyText(reviewer)).includes('Deleted and edited'), { timeoutMs: 10_000, label: 'the "Deleted and edited" item' });
  await ctx.shot(reviewer, 'edit-delete-item');
  await clickInReview(reviewer, 'Keep item');
  await Promise.all(both.map((d) => waitConflictCount(ctx, d, 0)));
  await waitBoth(ctx, both, entry.id, (e) => e?.host === '10.3.0.201', 'the kept item with B\'s edit');
  ctx.step('edit-versus-delete resolved with [Keep item]; the item and B\'s edit survive on both');
}

// ---------- S4: plan downgrade and upgrade ----------

async function downgradeAndUpgrade(ctx) {
  const { user, a, b, ua, ub } = await openProPair(ctx, 's4', null);
  const byId = { [ua]: a, [ub]: b };

  const t0 = Date.now();
  await ctx.setTier(user.id, 'free');
  ctx.step('plan set to free');
  const rows = await ctx.waitFor(async () => {
    const r = [...(await leaseByDevice(ctx, user.email)).values()];
    return r.filter((x) => x.status === 'displaced').length === 1 ? r : null;
  }, { timeoutMs: PLAN_CHANGE_MS, intervalMs: 500, label: 'one device displaced by the plan limit' });
  const gone = rows.find((r) => r.status === 'displaced');
  const kept = rows.find((r) => r.status !== 'displaced');
  ctx.checkEqual({ reason: gone.displaced_reason, keeperStatus: kept?.status }, { reason: 'plan_limit', keeperStatus: 'active' }, 'exactly one device displaced with plan_limit');
  const [loser, keeper] = [byId[gone.device_id], byId[kept.device_id]];
  const modal = await waitForDisplaced(loser, { timeoutMs: Math.max(5_000, PLAN_CHANGE_MS - (Date.now() - t0)) });
  ctx.step(`${loser.name} displaced after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${modal.title}"`);
  ctx.check(modal.text.includes('Your plan now allows this vault on one device at a time.'), `plan-limit text: ${modal.text.slice(0, 200)}`);
  ctx.check(!(await displacedShown(keeper)), `${keeper.name} keeps the vault open`);
  ctx.check(await ctx.ui.invoke(keeper, 'vault_is_unlocked'), `${keeper.name} is still unlocked`);
  await ctx.shot(loser, 'plan-limit-modal');

  await ctx.setTier(user.id, 'pro');
  ctx.step('plan set back to pro');
  const res = await useHereFromDisplaced(loser, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs ?? [] }, { outcome: 'unlocked', dialogs: [] }, `${loser.name} reopens without a take-over dialog`);
  await ctx.shot(loser, 'reopened-on-pro');
  await waitLeases(ctx, user.email, { [ua]: { status: 'active' }, [ub]: { status: 'active' } }, { label: 'both devices active on Pro again' });
  ctx.check(!(await displacedShown(keeper)), `${keeper.name} was not displaced by the reopen`);
}

// ---------- S5: sign-out releases the lease ----------

async function signOutReleases(ctx) {
  const user = await ctx.createUser('free');
  const a = await ctx.launchDevice('s5a');
  await ctx.flows.signIn(a, user);
  await ctx.flows.createVault(a, vaultFor(ctx, 's5'), PW);
  const ua = deviceUuid(a);
  await waitLeases(ctx, user.email, { [ua]: { status: 'active' } }, { label: 'A holds the lease' });
  const t0 = Date.now();
  await ctx.flows.signOut(a);
  await waitLeases(ctx, user.email, { [ua]: { status: 'released' } }, { timeoutMs: RELEASE_MS, label: 'released at sign-out' });
  ctx.step(`lease released ${((Date.now() - t0) / 1000).toFixed(1)} s after sign-out`);
  await ctx.shot(a, 'signed-out');
}

// ---------- S6: signed-out owner claims ----------

async function signedOutClaims(ctx) {
  const { flows } = ctx;
  const [a, b] = await launchPair(ctx, 's6');
  await Promise.all([flows.enterLocalMode(a), flows.enterLocalMode(b)]);
  const vault = vaultFor(ctx, 's6');
  await flows.createVault(a, vault, PW);
  await ctx.waitFor(async () => (await ctx.ui.readSyncState(a)).status?.kind === 'up-to-date', { timeoutMs: 20_000, label: 'A up to date' });
  const limit = (await ctx.ui.readSyncState(a)).deviceLimit;
  ctx.checkEqual(limit?.limit, 1, `a signed-out device counts as Free (${JSON.stringify(limit)})`);

  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [TAKEOVER_TITLE] }, 'B sees the take-over dialog from the owner claim');
  await ctx.shot(b, 'claim-takeover-dialog');
  const t0 = Date.now();
  await useHereFromTakeover(b);
  await ctx.shot(b, 'opened');
  const displaced = await waitForDisplaced(a, { timeoutMs: CLAIM_DISPLACED_MS });
  ctx.step(`A displaced by the claim after ${((Date.now() - t0) / 1000).toFixed(1)} s: "${displaced.title}"`);
  ctx.check(displaced.text.includes('This vault was opened on'), `owner-claim text: ${displaced.text.slice(0, 200)}`);
  await ctx.shot(a, 'claim-displaced');
  ctx.check(!(await displacedShown(b)), 'B keeps the vault');
}

// ---------- S8: desktop 0.17 editing the shared file in place ----------

async function legacyWriter(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('pro');
  const a = await ctx.launchDevice('s8a');
  await flows.signIn(a, user);
  const vault = vaultFor(ctx, 's8');
  await flows.createVault(a, vault, PW);
  const entry = await flows.addEntry(a, { name: 's8 server', host: '10.8.0.1', port: 22 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id && r.host === '10.8.0.1'), 'the entry is published');
  await ctx.waitFor(async () => (await ui.readSyncState(a)).status?.kind === 'up-to-date', { timeoutMs: 20_000, label: 'A up to date' });

  const left = await suite.watch.expect(() => legacyEditInPlace(vault, entry.id, { host: '10.8.0.99' }));
  ctx.checkEqual(left, [], 'the legacy writer closed cleanly with no side files left');
  ctx.step('desktop 0.17 style in-place edit written to the shared file');

  const t0 = Date.now();
  await waitForEntry(a, entry.id, (e) => e?.host === '10.8.0.99', { timeoutMs: CONVERGE_MS, label: 'the legacy host absorbed' });
  ctx.step(`A absorbed the legacy edit after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await ctx.sleep(3_000);
  ctx.checkEqual(await conflictCount(a), 0, 'a plain legacy edit creates no conflict');
  ctx.checkEqual((await listConflicts(a)).length, 0, 'the review queue is empty');
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id && r.host === '10.8.0.99'), 'the shared file keeps the legacy host');
  await ctx.shot(a, 'legacy-edit-absorbed');
}

// ---------- S7: file safety across the suite ----------

async function fileSafety(ctx) {
  const { flows } = ctx;
  const user = await ctx.createUser('pro');
  const a = await ctx.launchDevice('s7a');
  await flows.signIn(a, user);
  const vault = vaultFor(ctx, 's7');
  await flows.createVault(a, vault, PW);
  const entry = await flows.addEntry(a, { name: 's7 server', host: '10.7.0.1', port: 22 });
  await flows.updateEntry(a, entry.id, { host: '10.7.0.2' });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id && r.host === '10.7.0.2'), 'the edit is published');
  await flows.lockVault(a);
  await flows.openVault(a, vault, PW, { expect: 'unlocked' });
  await flows.updateEntry(a, entry.id, { port: 2207 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id && r.port === 2207), 'the edit after reopening is published');
  await ctx.quitDevice(a);
  ctx.step('vault created, edited, locked, reopened, edited and closed');

  const w = suite.watch;
  ctx.step(`side-file watch: ${w.polls()} polls over the suite; ${w.expectedSightings().length} expected sighting(s) during the legacy writer`);
  ctx.checkEqual(w.violations(), [], 'no -wal / -shm / -journal file ever appeared in the cloud folder');
  for (const file of [...suite.vaults].filter((f) => fs.existsSync(f))) {
    const rel = path.relative(ctx.cloudDir, file);
    ctx.checkEqual(sideFilesNextTo(file), [], `${rel}: no side files now`);
    const h = sqliteHeader(file);
    ctx.checkEqual(h, { magicOk: true, writeVersion: 2, readVersion: 2 }, `${rel}: SQLite header bytes 18/19 are 2/2 (WAL)`);
    const ios = openLikeIos105(file, scratch(ctx));
    ctx.checkEqual(ios, { journalMode: 'wal', quickCheck: 'ok', schemaVersion: '10' }, `${rel}: opens like iOS 1.0.5 (journal_mode = WAL inside BEGIN IMMEDIATE)`);
    ctx.step(`${rel}: header 2/2, iOS 1.0.5 open ok`);
  }
}

export default {
  id: 'sync',
  title: 'Personal vault sync and device leases',
  scenarios: [
    { id: 'free-takeover-server', title: 'Free: B takes over A\'s vault through the server lease; A is displaced', run: freeTakeoverScenario },
    { id: 'take-back', title: 'Free: A takes the vault back from its displaced modal; B is displaced', run: takeBack },
    { id: 'pro-merge-and-conflict', title: 'Pro: concurrent edits merge; same-field and edit-versus-delete conflicts are reviewed and resolved', run: proMergeAndConflict },
    { id: 'downgrade-and-upgrade', title: 'Pro to Free displaces exactly one device; back to Pro reopens without a take-over', run: downgradeAndUpgrade },
    { id: 'signout-releases-lease', title: 'Signing out releases the lease at once', run: signOutReleases },
    { id: 'signed-out-claims', title: 'Signed out: the in-file owner claim drives the take-over and displaces A', run: signedOutClaims },
    { id: 'legacy-writer', title: 'A desktop 0.17 in-place edit of the shared file is absorbed without a conflict', run: legacyWriter },
    { id: 'file-safety', title: 'No SQLite side files in the cloud folder; published files have a WAL header and open like iOS 1.0.5', run: fileSafety },
  ],
};
