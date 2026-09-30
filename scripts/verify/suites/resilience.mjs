// Resilience of personal vault sync (docs/MULTI_DEVICE_SYNC.md 4.2, 6.5-6.8), live: opening and
// editing while Supabase is unreachable, a take-over that an offline device learns about when its
// link comes back, the cached Pro tier offline, team vaults beside personal sync, and export and
// import. Each scenario uses its own device names and its own folder under <cloud>/<scenario>/.

import fs from 'node:fs';
import path from 'node:path';
import { OFFLINE_BADGE, OFFLINE_TEXT, deliverFile, leaseRowsOf, ownerClaimOf, sessionFacts, syncTabStatus, waitSessionFacts } from '../lib/offline-flows.mjs';
import { readDeviceSettings, waitForSetting, writeDeviceSettings } from '../lib/settings-file.mjs';
import { clickInDialog } from '../lib/ui-forms.mjs';
import { deviceUuid, withPrivateCopy } from '../lib/sync-files.mjs';
import { TAKEOVER_TITLE, WAITING_TITLE, conflictCount, dialogDetails, displacedShown, listConflicts, unlockOutcome, useHereFromTakeover, waitForDisplaced, waitForEntry, waitForEntryInUi } from '../lib/sync-flows.mjs';
import { activeVaultType, lineageDirs, lockFromVaultMenu, openTeamVaultInUi, recoverIdentityKey, serverTeamEntries, teamVaultFile } from '../lib/team-flows.mjs';
import { createTeamVault, ensureIdentityKey } from '../lib/team.mjs';
import { exportVault, importExport, previewExport } from '../lib/vault-transfer.mjs';
import { createFolder } from '../lib/copy-flows.mjs';
import { scratchDir, vaultAt, waitShared } from '../lib/scenario-helpers.mjs';

const PW = 'verify-resilience-password-1';
const EXPORT_PASS = 'verify-export-passphrase-1';
const FREE_TEXT = 'On the Free plan a vault can be open on one device at a time.';
// A running device turns unconfirmed at its next failed heartbeat: every 30 s (6.2), or at once
// after a publish. The Realtime error alone does not change the lease.
const OFFLINE_BADGE_MS = 45_000;
// 6.2: an unconfirmed device retries acquire every 60 s; plus the RPC and one heartbeat.
const RECONFIRM_MS = 80_000;
// 6.2: after the link returns, the next heartbeat (every 30 s) answers 'displaced'; the final save takes up to 15 s.
const RECONNECT_DISPLACED_MS = 60_000;
const CONVERGE_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const secondsSince = (t0) => ((Date.now() - t0) / 1000).toFixed(1);

function waitLease(ctx, email, deviceId, pred, { timeoutMs = 15_000, label }) {
  return ctx.waitFor(async () => {
    const rows = await leaseRowsOf(email, deviceId);
    if (rows.length === 1 && pred(rows[0])) return rows[0];
    throw new Error(`rows ${JSON.stringify(rows.map((r) => [r.status, r.displaced_reason, r.heartbeat_at]))}`);
  }, { timeoutMs, intervalMs: 500, label });
}

/** The take-over dialog's text once its Free-plan line has rendered (it can follow the title). */
function waitFreeRuleLine(ctx, device) {
  return ctx.waitFor(async () => (await dialogDetails(device)).some((d) => d.title === TAKEOVER_TITLE && d.text.includes(FREE_TEXT)), {
    timeoutMs: 5_000,
    label: `${device.name}: "${FREE_TEXT}" in the take-over dialog`,
  });
}

async function expectNoDialogs(ctx, device, why) {
  ctx.checkEqual((await dialogDetails(device)).map((d) => d.title), [], `${device.name}: no dialog ${why}`);
}

// ---------- R1: open and edit offline, confirmed once the link returns ----------

async function offlineOpen(ctx) {
  const { flows } = ctx;
  const user = await ctx.createUser('free');
  const proxy = await ctx.supabaseProxy();
  const a = await ctx.launchDevice('r1a', { env: proxy.env });
  await flows.signIn(a, user);
  const vault = vaultAt(ctx, 'r1');
  proxy.cut();
  ctx.step('r1a: Supabase link cut after sign-in');

  await flows.createVault(a, vault, PW);
  const entry = await flows.addEntry(a, { name: 'r1 server', host: '10.21.0.1', port: 22 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id), 'the entry created offline');
  await flows.lockVault(a);
  await flows.openVault(a, vault, PW, { expect: 'unlocked' });
  ctx.step('r1a opened the existing vault while offline');
  const offline = await waitSessionFacts(a, (f) => f.badge === OFFLINE_BADGE, { timeoutMs: OFFLINE_BADGE_MS, label: 'offline badge' });
  ctx.checkEqual({ limit: offline.limit, softLocked: offline.softLocked }, { limit: 1, softLocked: false }, `unconfirmed Free device: limit 1, not locked (source ${offline.source})`);
  const tab = await syncTabStatus(a);
  ctx.checkEqual(tab.detail, OFFLINE_TEXT, `Settings > Sync shows the offline badge (status "${tab.status}", ${tab.plan})`);
  await ctx.shot(a, 'offline-badge');

  await flows.updateEntry(a, entry.id, { host: '10.21.0.2' });
  const second = await flows.addEntry(a, { name: 'r1 offline', host: '10.21.0.3', port: 22 });
  await waitShared(ctx, vault, (rows) => rows.some((r) => r.id === entry.id && r.host === '10.21.0.2') && rows.some((r) => r.id === second.id), 'the offline edits');
  ctx.step('offline edits are in the shared file');
  const ua = deviceUuid(a);
  ctx.checkEqual(await leaseRowsOf(user.email, ua), [], 'the server has no lease row while r1a is offline');
  ctx.check(proxy.stats().refused > 0, `r1a tried to reach Supabase while cut (${JSON.stringify(proxy.stats())})`);

  proxy.restore();
  const t0 = Date.now();
  const row = await waitLease(ctx, user.email, ua, (r) => r.status === 'active', { timeoutMs: RECONFIRM_MS, label: 'r1a: an active lease row after the link returned' });
  ctx.step(`lease row appeared ${secondsSince(t0)} s after the link returned, without user action`);
  ctx.checkEqual(row.vault_key, offline.lineageId, 'the lease is for the open vault');
  const online = await waitSessionFacts(a, (f) => f.badge === null && f.source === 'server', { timeoutMs: 10_000, label: 'confirmed: badge gone, limit from the server' });
  ctx.checkEqual(online.limit, 1, 'the server limit is 1 on Free');
  const tabOnline = await syncTabStatus(a);
  ctx.check(tabOnline.detail !== OFFLINE_TEXT, `Settings > Sync no longer shows the offline badge (detail "${tabOnline.detail}")`);
  await expectNoDialogs(ctx, a, 'after reconnecting (no other device holds the vault)');
  await ctx.shot(a, 'confirmed');
}

// ---------- R2: taken over while offline; learns it on reconnect ----------

async function offlineTakeoverReconnect(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('free');
  const proxy = await ctx.supabaseProxy();
  const [a, b] = await Promise.all([ctx.launchDevice('r2a', { env: proxy.env }), ctx.launchDevice('r2b')]);
  await Promise.all([flows.signIn(a, user), flows.signIn(b, user)]);
  // Each device has its own copy of the drive folder, so B's publishes (and its owner claim) do
  // not reach A until the harness delivers them: A can only learn of the take-over from the server.
  const fileA = vaultAt(ctx, 'r2', 'devA', 'Drive');
  const fileB = vaultAt(ctx, 'r2', 'devB', 'Drive');
  await flows.createVault(a, fileA, PW);
  const e1 = await flows.addEntry(a, { name: 'r2 server', host: '10.22.0.1', port: 22 });
  await waitShared(ctx, fileA, (rows) => rows.some((r) => r.id === e1.id), 'A published e1');
  const [ua, ub] = [deviceUuid(a), deviceUuid(b)];
  await waitLease(ctx, user.email, ua, (r) => r.status === 'active', { label: 'A holds the lease' });

  proxy.cut();
  const cutAt = Date.now();
  await flows.updateEntry(a, e1.id, { host: '10.22.0.99' });
  const e2 = await flows.addEntry(a, { name: 'r2 offline', host: '10.22.0.2', port: 22 });
  await waitShared(ctx, fileA, (rows) => rows.some((r) => r.id === e1.id && r.host === '10.22.0.99') && rows.some((r) => r.id === e2.id), 'A\'s offline edits');
  await waitSessionFacts(a, (f) => f.badge === OFFLINE_BADGE, { timeoutMs: OFFLINE_BADGE_MS, label: 'offline badge' });
  ctx.step(`A offline: edits published, badge ${secondsSince(cutAt)} s after the cut`);
  deliverFile(fileA, fileB);
  ctx.step('A\'s offline edits published; the drive delivered A\'s file to B');

  const res = await flows.openVault(b, fileB, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [TAKEOVER_TITLE] }, 'B is offered a take-over (the server still sees A)');
  await waitFreeRuleLine(ctx, b);
  await ctx.shot(b, 'takeover-dialog');
  await useHereFromTakeover(b);
  await waitForEntry(b, e1.id, (e) => e?.host === '10.22.0.99', { label: 'A\'s offline host edit' });
  await waitForEntry(b, e2.id, (e) => e !== null, { label: 'A\'s offline entry' });
  ctx.step(`B took over ${secondsSince(cutAt)} s after the cut and has A's offline edits`);
  const displacedRow = await waitLease(ctx, user.email, ua, (r) => r.status === 'displaced' && r.displaced_reason === 'takeover' && r.displaced_by_device === ub, { label: 'A displaced on the server' });

  ctx.check(!(await displacedShown(a)) && (await ui.invoke(a, 'vault_is_unlocked')), 'A, still offline, has not learned of the take-over');
  await flows.updateEntry(a, e2.id, { port: 2202 });
  await waitShared(ctx, fileA, (rows) => rows.some((r) => r.id === e2.id && r.port === 2202), 'A\'s edit made after the take-over');

  proxy.restore();
  const t0 = Date.now();
  const modal = await waitForDisplaced(a, { timeoutMs: RECONNECT_DISPLACED_MS });
  ctx.step(`A displaced ${secondsSince(t0)} s after the link returned: "${modal.title}"`);
  ctx.check(modal.text.includes('This vault is now open on'), `take-over wording: ${modal.text.slice(0, 200)}`);
  ctx.check(modal.text.includes('Your changes from this device were saved.'), 'A saved its changes before locking');
  await ctx.shot(a, 'displaced-after-reconnect');
  await waitSessionFacts(a, (f) => f.softLocked, { timeoutMs: 10_000, label: 'soft-locked' });
  ctx.check(!(await ui.invoke(a, 'vault_is_unlocked')), 'A is locked');

  const released = await waitLease(ctx, user.email, ua, (r) => r.status === 'displaced' && Date.parse(r.heartbeat_at) > Date.parse(displacedRow.heartbeat_at) && r.pending_changes === false, { label: 'A reported its final save' });
  ctx.checkEqual({ reason: released.displaced_reason, by: released.displaced_by_device }, { reason: 'takeover', by: ub }, 'A\'s row still records the take-over by B');
  await waitLease(ctx, user.email, ub, (r) => r.status === 'active', { label: 'B keeps the lease' });
  const onA = await waitShared(ctx, fileA, (rows) => rows.some((r) => r.id === e2.id && r.port === 2202) && rows.some((r) => r.id === e1.id && r.host === '10.22.0.99'), 'nothing lost');
  ctx.step(`A's shared file keeps all ${onA.length} rows, the post-take-over edit included`);
  ctx.check(!(await displacedShown(b)), 'B keeps the vault');
}

// ---------- R3: the cached Pro tier while offline ----------

/** Sign in once online (the app caches the tier in settings.json), then quit. */
async function onlineOnce(ctx, devices, user) {
  await Promise.all(devices.map((d) => ctx.flows.signIn(d, user)));
  await Promise.all(devices.map((d) => waitForSetting(d, 'cached_tier_capabilities', (v) => v?.vault_max_open_devices === -1)));
  await Promise.all(devices.map((d) => ctx.quitDevice(d)));
}

/** Relaunches `name` behind the (cut) proxy; it must come up signed in from the cached session. */
async function relaunchCached(ctx, name, proxy, user) {
  const d = await ctx.launchDevice(name, { env: proxy.env });
  await ctx.flows.waitForScreen(d, 'hub');
  const auth = await ctx.ui.invoke(d, 'auth_get_state');
  ctx.checkEqual({ mode: auth.authMode, user: auth.user?.id }, { mode: 'cached', user: user.id }, `${name} relaunched offline in cached mode`);
  return d;
}

/** Opening `vault` offline, with the signed-out device's claim live, gives the one-device take-over dialog. */
async function expectFreeTakeover(ctx, device, vault, why) {
  const res = await ctx.flows.openVault(device, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [TAKEOVER_TITLE] }, `${device.name} (${why}) honors the claim`);
  await waitFreeRuleLine(ctx, device);
}

async function cachedProOffline(ctx) {
  const { flows } = ctx;
  const user = await ctx.createUser('pro');
  const proxy = await ctx.supabaseProxy();
  const [a, b0, c0] = await Promise.all([ctx.launchDevice('r3a'), ctx.launchDevice('r3b', { env: proxy.env }), ctx.launchDevice('r3c', { env: proxy.env })]);
  await Promise.all([flows.signIn(a, user), onlineOnce(ctx, [b0, c0], user)]);
  ctx.step('r3b and r3c signed in once online (tier cached: vault_max_open_devices -1) and quit');

  const vault = vaultAt(ctx, 'r3');
  await flows.createVault(a, vault, PW);
  const ua = deviceUuid(a);
  await waitLease(ctx, user.email, ua, (r) => r.status === 'active', { label: 'A holds a lease' });
  // A signed-out device counts as Free (6.7): it writes an owner claim that limit-1 devices honor.
  const l = await ctx.launchDevice('r3l');
  await flows.enterLocalMode(l);
  // 6.11 signed out: r3a's presence says it has the vault open, so r3l may briefly show "Getting the latest changes".
  const first = await flows.openVault(l, vault, PW);
  const lres = first.outcome === 'dialog' && first.dialogs.every((t) => t === WAITING_TITLE) ? await unlockOutcome(l) : first;
  ctx.checkEqual(lres.outcome, 'unlocked', `the signed-out device opens the Pro vault (first: ${first.outcome} ${first.dialogs?.join(', ') ?? ''})`);
  const ul = deviceUuid(l);
  await ctx.waitFor(() => ownerClaimOf(vault, scratchDir(ctx)) === ul, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'the signed-out device\'s owner claim in the shared file' });
  ctx.step('r3l (signed out) holds the owner claim in the shared file');

  proxy.cut();
  const stale = new Date(Date.now() - 8 * DAY_MS).toISOString();
  writeDeviceSettings(c0, { cached_tier_timestamp: stale });
  const [b, cStale] = await Promise.all([relaunchCached(ctx, 'r3b', proxy, user), relaunchCached(ctx, 'r3c', proxy, user)]);
  ctx.step(`r3b and r3c relaunched with Supabase cut; r3c's cached_tier_timestamp set to ${stale} (8 days old)`);
  await expectFreeTakeover(ctx, cStale, vault, 'an 8-day-old cache');
  await clickInDialog(cStale, TAKEOVER_TITLE, 'Cancel');
  await ctx.waitFor(async () => (await dialogDetails(cStale)).length === 0, { timeoutMs: 10_000, label: 'r3c: take-over dialog closed' });
  await ctx.quitDevice(cStale);

  const future = new Date(Date.now() + DAY_MS).toISOString();
  writeDeviceSettings(cStale, { cached_tier_timestamp: future });
  const c = await relaunchCached(ctx, 'r3c', proxy, user);
  await expectFreeTakeover(ctx, c, vault, 'a cache dated in the future');
  await ctx.shot(c, 'future-cache-takeover');
  await useHereFromTakeover(c);
  const factsC = await waitSessionFacts(c, (f) => f.limit !== null && f.badge === OFFLINE_BADGE, { label: 'r3c open offline' });
  ctx.checkEqual({ limit: factsC.limit, source: factsC.source }, { limit: 1, source: 'default' }, 'a cache dated in the future is rejected: limit 1');
  ctx.checkEqual(readDeviceSettings(c).cached_tier_timestamp, future, 'r3c kept the future-dated cache it rejected');
  await ctx.waitFor(() => ownerClaimOf(vault, scratchDir(ctx)) === deviceUuid(c), { timeoutMs: CONVERGE_MS, intervalMs: 500, label: 'r3c\'s owner claim in the shared file' });

  const openB = await flows.openVault(b, vault, PW);
  ctx.checkEqual({ outcome: openB.outcome, dialogs: openB.dialogs ?? [] }, { outcome: 'unlocked', dialogs: [] }, 'r3b (cache within 7 days) opens with no take-over prompt, although r3c\'s claim is live');
  const factsB = await waitSessionFacts(b, (f) => f.limit !== null && f.badge === OFFLINE_BADGE, { label: 'r3b open offline' });
  ctx.checkEqual({ limit: factsB.limit, source: factsB.source }, { limit: -1, source: 'tier-cache' }, 'r3b\'s limit comes from the cached Pro tier');
  await ctx.shot(b, 'cached-pro-open');

  const eb = await flows.addEntry(b, { name: 'r3 from offline b', host: '10.23.0.2', port: 22 });
  await waitForEntry(a, eb.id, (e) => e !== null, { timeoutMs: CONVERGE_MS, label: 'r3b\'s entry on r3a' });
  ctx.step('three devices have the Pro vault open; r3b\'s offline edit reached r3a');
  for (const d of [a, b]) ctx.check(!(await displacedShown(d)), `${d.name} keeps the vault`);
  const rows = await ctx.leaseRows(user.email);
  ctx.checkEqual(rows.map((r) => [r.device_id, r.status]), [[ua, 'active']], 'only r3a (online) holds a server lease');
}

// ---------- R4: team vaults beside personal sync ----------

async function teamVaultRegression(ctx) {
  const { flows } = ctx;
  const user = await ctx.createUser('team');
  const team = await ctx.createTeam(user);
  const [a, b] = await Promise.all([ctx.launchDevice('r4a'), ctx.launchDevice('r4b')]);
  const who = await Promise.all([flows.signIn(a, user), flows.signIn(b, user)]);
  ctx.checkEqual(who.map((w) => w.tier), ['team', 'team'], 'both devices signed in on the Team plan');

  const personal = vaultAt(ctx, 'r4');
  await flows.createVault(a, personal, PW);
  const p1 = await flows.addEntry(a, { name: 'r4 personal', host: '10.24.0.1', port: 22 });
  await flows.openVault(b, personal, PW, { expect: 'unlocked' });
  await waitForEntry(b, p1.id, (e) => e !== null, { label: 'the personal entry' });
  const lineage = (await sessionFacts(a)).lineageId;
  const dirs = new Map([a, b].map((d) => [d.name, lineageDirs(d)]));
  for (const d of [a, b]) ctx.check(dirs.get(d.name).some((x) => x.endsWith(`/${lineage}`)), `${d.name} has the personal vault's lineage folder (${dirs.get(d.name).join(', ')})`);
  const keysOf = async () => [...new Set((await ctx.leaseRows(user.email)).map((r) => r.vault_key))].sort();
  ctx.checkEqual(await keysOf(), [lineage], 'lease rows exist only for the personal vault');
  ctx.step(`personal vault syncs between r4a and r4b (lineage ${lineage.slice(0, 8)})`);

  const key = await ensureIdentityKey(a);
  ctx.check(key.created, 'r4a created the identity key');
  const tv = await createTeamVault(a, team, `R4 team ${ctx.run.shortId}`);
  await flows.lockVault(a);
  await openTeamVaultInUi(a, tv);
  const t1 = await flows.addEntry(a, { name: 'r4 team one', host: '10.24.1.1', port: 22 });
  const t2 = await flows.addEntry(a, { name: 'r4 team two', host: '10.24.1.2', port: 22 });
  await ctx.waitFor(async () => {
    const ids = (await serverTeamEntries(tv.id)).map((r) => r.id);
    return [t1.id, t2.id].every((id) => ids.includes(id));
  }, { timeoutMs: CONVERGE_MS, intervalMs: 1_000, label: 'the team entries in vault_entries' });
  ctx.step(`team vault ${tv.id.slice(0, 8)} created on r4a; its entries reached the server`);

  await flows.lockVault(b);
  await recoverIdentityKey(b, key.recoveryPassphrase);
  await openTeamVaultInUi(b, tv);
  await waitForEntry(b, t1.id, (e) => e?.host === '10.24.1.1', { timeoutMs: CONVERGE_MS, label: 'team entry one via team sync' });
  await waitForEntry(b, t2.id, (e) => e?.host === '10.24.1.2', { timeoutMs: CONVERGE_MS, label: 'team entry two via team sync' });
  await waitForEntryInUi(b, t1.name);
  await ctx.shot(b, 'team-vault-entries');

  for (const d of [a, b]) {
    ctx.checkEqual(lineageDirs(d), dirs.get(d.name), `${d.name}: the team vault added no personal-sync lineage folder`);
    const cache = teamVaultFile(d, tv.id);
    ctx.check(fs.existsSync(cache), `${d.name}: the team vault's local cache exists (${path.relative(d.root, cache)})`);
    const syncTables = withPrivateCopy(cache, scratchDir(ctx), (db) => db.prepare("select count(*) as n from sqlite_master where name = 'sync_state'").get().n);
    const lineageRow = syncTables === 0 ? null : withPrivateCopy(cache, scratchDir(ctx), (db) => db.prepare("select value from sync_state where key = 'lineage_id'").get()?.value ?? null);
    ctx.checkEqual(lineageRow, null, `${d.name}: the team vault file has no sync lineage`);
    ctx.checkEqual((await sessionFacts(d)).lineageId, null, `${d.name}: personal sync is not running for the team vault`);
  }
  ctx.checkEqual(await keysOf(), [lineage], 'no personal_vault_sessions row for the team vault');

  await Promise.all([lockFromVaultMenu(a, tv.name), lockFromVaultMenu(b, tv.name)]);
  await flows.openVault(a, personal, PW, { expect: 'unlocked' });
  await flows.openVault(b, personal, PW, { expect: 'unlocked' });
  ctx.checkEqual([await activeVaultType(a), await activeVaultType(b)], ['personal', 'personal'], 'both devices are back on the personal vault');
  await flows.updateEntry(a, p1.id, { host: '10.24.0.2' });
  const p2 = await flows.addEntry(b, { name: 'r4 personal two', host: '10.24.0.3', port: 22 });
  await waitForEntry(b, p1.id, (e) => e?.host === '10.24.0.2', { timeoutMs: CONVERGE_MS, label: 'r4a\'s personal edit' });
  await waitForEntry(a, p2.id, (e) => e !== null, { timeoutMs: CONVERGE_MS, label: 'r4b\'s personal entry' });
  const names = (await flows.listEntries(a)).map((e) => e.name);
  ctx.check(!names.includes(t1.name) && !names.includes(t2.name), 'no team entry leaked into the personal vault');
  ctx.checkEqual(await keysOf(), [lineage], 'lease rows are still only for the personal vault');
  ctx.step('personal sync works both ways after using the team vault');
}

// ---------- R5: export and import ----------

async function exportAndImport(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('pro');
  const [a, b] = await Promise.all([ctx.launchDevice('r5a'), ctx.launchDevice('r5b')]);
  await Promise.all([flows.signIn(a, user), flows.signIn(b, user)]);

  const source = vaultAt(ctx, 'r5', 'source');
  await flows.createVault(a, source, PW);
  const folder = await createFolder(a, 'R5 Servers');
  const cred = await flows.addEntry(a, { name: 'r5 admin login', entry_type: 'credential', host: null, port: null, username: 'admin', password: 'r5-cred-secret' });
  const ssh = await flows.addEntry(a, { name: 'r5 web01', host: '10.25.0.11', port: 22, folder_id: folder.id, credential_id: cred.id });
  const web = await flows.addEntry(a, { name: 'r5 portal', entry_type: 'web', host: 'https://portal.r5.test', port: null, folder_id: folder.id, username: 'ops', password: 'r5-web-secret' });
  const file = path.join(scratchDir(ctx), `r5-${ctx.run.shortId}.conduit-export`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exported = await exportVault(a, file, EXPORT_PASS);
  ctx.checkEqual(exported, { folderCount: 1, entryCount: 3 }, 'export_execute wrote 1 folder and 3 entries');
  const preview = await previewExport(a, file, EXPORT_PASS);
  ctx.checkEqual({ entries: preview.entry_count, folders: preview.folder_tree.map((f) => f.name) }, { entries: 3, folders: ['R5 Servers'] }, 'the preview reads the export');
  const wrong = await ui.invokeResult(a, 'import_preview_export', { filePath: file, passphrase: 'not-the-passphrase' });
  ctx.check(!wrong.ok, 'a wrong passphrase cannot read the export');
  await flows.lockVault(a);

  const target = vaultAt(ctx, 'r5', 'target');
  await flows.createVault(a, target, PW);
  const y = await flows.addEntry(a, { name: 'r5 conflicted', host: '10.25.1.1', port: 22 });
  await flows.openVault(b, target, PW, { expect: 'unlocked' });
  await waitForEntry(b, y.id, (e) => e !== null, { label: 'the target entry' });
  await Promise.all([flows.updateEntry(a, y.id, { host: '10.25.1.100' }), flows.updateEntry(b, y.id, { host: '10.25.1.200' })]);
  await Promise.all([a, b].map((d) => ctx.waitFor(async () => (await conflictCount(d)) === 1, { timeoutMs: CONVERGE_MS, intervalMs: 500, label: `${d.name}: the host conflict` })));
  ctx.step('the target vault has an open same-field conflict on "r5 conflicted" on both devices');

  const res = await importExport(a, file, EXPORT_PASS);
  ctx.checkEqual(res, { foldersCreated: 1, entriesCreated: 3, credentialRefsRemapped: 1, credentialRefsCleared: 0 }, 'import_execute_export result');
  const onA = await flows.listEntries(a);
  const byName = (n) => onA.find((e) => e.name === n);
  for (const n of [cred.name, ssh.name, web.name]) ctx.check(byName(n) && byName(n).id !== [cred, ssh, web].find((e) => e.name === n).id, `"${n}" imported with a new id`);
  const importedFolder = (await ui.invoke(a, 'folder_list')).find((f) => f.name === 'R5 Servers');
  ctx.check(importedFolder && byName(ssh.name).folder_id === importedFolder.id && byName(web.name).folder_id === importedFolder.id, 'imported entries sit in the imported folder');
  ctx.checkEqual(byName(ssh.name).credential_id, byName(cred.name).id, 'the credential reference points at the imported credential');
  const full = await ui.invoke(a, 'entry_get_full', { id: byName(web.name).id });
  ctx.checkEqual([full.username, full.password], ['ops', 'r5-web-secret'], 'secrets survive export and import');
  await waitForEntryInUi(a, web.name);

  await Promise.all([cred, ssh, web].map((e) => ctx.waitFor(async () => (await flows.listEntries(b)).some((x) => x.name === e.name), { timeoutMs: CONVERGE_MS, intervalMs: 500, label: `r5b: imported "${e.name}"` })));
  ctx.step('the imported entries synced to r5b');
  await Promise.all([a, b].map((d) => ctx.waitFor(async () => (await ui.readSyncState(d)).status?.kind === 'up-to-date', { timeoutMs: CONVERGE_MS, label: `${d.name}: up to date after the import` })));
  ctx.checkEqual([await conflictCount(a), await conflictCount(b)], [1, 1], 'the open conflict is still open on both devices after the import');
  const hosts = (await listConflicts(a)).flatMap((g) => g.items).map((i) => JSON.stringify(i)).join(' ');
  ctx.check(hosts.includes('10.25.1.100') && hosts.includes('10.25.1.200'), 'both conflicting hosts are still offered');
  await ctx.shot(a, 'import-with-open-conflict');
}

export default {
  id: 'resilience',
  title: 'Offline use, reconnect, cached tier, team vaults and export/import',
  scenarios: [
    { id: 'offline-open', title: 'Free, Supabase cut: the vault opens and edits publish; the lease is confirmed once the link returns', run: offlineOpen },
    { id: 'offline-takeover-reconnect', title: 'Free: B takes over while A is offline; A learns it on reconnect, locks, and loses nothing', run: offlineTakeoverReconnect },
    { id: 'cached-pro-offline', title: 'Pro offline: the cached tier keeps multi-device use; an 8-day-old or future-dated cache falls back to limit 1', run: cachedProOffline },
    { id: 'team-vault-regression', title: 'Team vault syncs between two devices with no personal-sync state; personal sync still works', run: teamVaultRegression },
    { id: 'import-export', title: 'Export, then import into another vault: entries arrive on both devices; an open conflict stays open', run: exportAndImport },
  ],
};
