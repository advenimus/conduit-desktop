// Vault ownership and plan limits (docs/PLAN_ENFORCEMENT.md 1, 3, 4; live scenarios L1-L8 of 7.3):
// the owner and another account's grace, grace ending and "Make my own copy", release and hand-over,
// release surviving a background re-acquire, the owner tag signed out and offline, the account
// device cap, the minimum app version, and the server refusing cloud backup on Free.
// Two accounts share one Vault.conduit per scenario in <cloud>/<scenario>/. Clocks are moved by
// backdating rows with ctx.sql, the same way the SQL tests do.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cancelUnlockDialog } from '../lib/password-flows.mjs';
import { deviceUuid, withPrivateCopy } from '../lib/sync-files.mjs';
import { dialogDetails, waitForDialog, waitForDisplaced, useHereFromTakeover } from '../lib/sync-flows.mjs';
import { openSettings, readSyncTab, cancelSettings } from '../lib/settings-flows.mjs';
import { clickInDialog, stubDialogs, waitForBanner, waitForToast } from '../lib/ui-forms.mjs';
import { cloudBackupSection, enableCloudBackup } from '../lib/backup-flows.mjs';
import { API_URL, getAnonKey, passwordSession } from '../lib/supabase.mjs';
import { SELECTORS } from '../lib/selectors.mjs';

const PW = 'verify-owner-password-1';
const NOT_OWNER_TITLE = 'This vault belongs to another account';
const S4_BODY = 'This vault, or the file it was copied from, belongs to another Conduit account.';
const S8_BODY = 'This vault belongs to another Conduit account, and your 14 days of access ended.';
const S8B_BODY = 'You released this vault and another account now owns it.';
const GRACE_BANNER = 'This vault belongs to another Conduit account. You can use it until';
const SHARED_BANNER = 'Another Conduit account is using this vault until';
const HEARTBEAT_MS = 45_000;
const DISPLACED_MS = 45_000;
const MIN_VERSION_OFF = '{"desktop": "0.0.0", "ios": "0.0.0"}';

const scratch = (ctx) => path.join(ctx.run.runDir, 'scratch');

function vaultIn(ctx, scenario, name = 'Vault.conduit') {
  const dir = path.join(ctx.cloudDir, scenario);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

async function signedIn(ctx, role, names) {
  const user = await ctx.createUser(role);
  const devices = await Promise.all(names.map((n) => ctx.launchDevice(n)));
  await Promise.all(devices.map((d) => ctx.flows.signIn(d, user)));
  ctx.step(`${names.join(', ')} signed in as ${role} ${user.email}`);
  return { user, devices };
}

async function lineageOf(ctx, device) {
  const s = await ctx.waitFor(async () => (await ctx.ui.readSyncState(device))?.vault ?? null, { timeoutMs: 20_000, label: `${device.name}: open vault` });
  return s.lineageId;
}

function ownerRow(ctx, lineage) {
  return ctx.sqlJson(
    'select owner_id, owner_since, grace_started_at, released_by from public.personal_vault_owners where vault_key = :\'k\'',
    { k: lineage },
  ).then((rows) => rows[0] ?? null);
}

function waitOwnership(ctx, device, kind, timeoutMs = HEARTBEAT_MS) {
  return ctx.waitFor(async () => {
    const o = (await ctx.ui.readSyncState(device))?.ownership ?? null;
    return o?.kind === kind ? o : null;
  }, { timeoutMs, intervalMs: 1_000, label: `${device.name}: ownership ${kind}` });
}

/** Ends the vault and pair grace clocks (15 days back), as the SQL tests do. */
async function endGrace(ctx, lineage, a, b) {
  await ctx.sql("update public.personal_vault_owners set grace_started_at = grace_started_at - interval '15 days' where vault_key = :'k'", { k: lineage });
  await ctx.sql(
    "update public.personal_vault_guest_grace set started_at = started_at - interval '15 days' where account_lo = least(:'a'::uuid, :'b'::uuid) and account_hi = greatest(:'a'::uuid, :'b'::uuid)",
    { a: a.id, b: b.id },
  );
  ctx.step('grace clocks moved back 15 days');
}

/** The provisional `_sync/owner/account` value in a vault file, read through a private copy. */
function ownerTagOf(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => {
    const rows = db.prepare(
      `select s.value, s.hlc_ms, s.hlc_c, s.dev from sync_sibling s join sync_rowkey k on k.rid = s.rid where k.row_id = 'owner' and s.reg = 'account'`,
    ).all();
    const top = rows.sort((x, y) => x.hlc_ms - y.hlc_ms || x.hlc_c - y.hlc_c || x.dev - y.dev).pop();
    return top ? JSON.parse(Buffer.isBuffer(top.value) ? top.value.toString('utf8') : String(top.value)) : null;
  });
}

/** Owner A creates the vault; B (another account) opens it during grace. */
async function ownerAndGuest(ctx, scenario, { roleA = 'pro', roleB = 'pro' } = {}) {
  const { flows } = ctx;
  const { user: ua, devices: [a] } = await signedIn(ctx, roleA, [`${scenario}a`]);
  const { user: ub, devices: [b] } = await signedIn(ctx, roleB, [`${scenario}b`]);
  const vault = vaultIn(ctx, scenario);
  await flows.createVault(a, vault, PW);
  const lineage = await lineageOf(ctx, a);
  const row = await ctx.waitFor(() => ownerRow(ctx, lineage), { timeoutMs: 10_000, label: 'owner row of the new vault' });
  ctx.checkEqual(row.owner_id, ua.id, 'the account that created the vault owns it');
  await ctx.waitFor(async () => (fs.existsSync(vault) ? ownerTagOf(vault, scratch(ctx)) : null), { timeoutMs: 30_000, label: 'the owner tag reached the shared file' });
  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual(res.outcome, 'unlocked', `B opens during grace (${res.dialogs?.join(', ') ?? ''})`);
  return { ua, ub, a, b, vault, lineage };
}

// ---------- L1 ----------

async function ownerAndGrace(ctx) {
  const { ua, ub, a, b, lineage } = await ownerAndGuest(ctx, 'o1');
  await waitOwnership(ctx, b, 'grace', 15_000);
  const banner = await waitForBanner(b, GRACE_BANNER, { timeoutMs: 15_000 });
  ctx.check(banner.text.includes(`Signed in as ${ub.email}.`), `the grace banner names B's account: ${banner.text}`);
  ctx.checkEqual(banner.actions, ['Switch account', 'Later', 'Try Team free', 'Make my own copy'], 'grace banner actions');
  await ctx.shot(b, 'grace-banner');
  const row = await ownerRow(ctx, lineage);
  ctx.check(row.owner_id === ua.id && row.grace_started_at !== null, `A still owns it and the grace clock runs (${JSON.stringify(row)})`);
  await waitForBanner(a, SHARED_BANNER, { timeoutMs: HEARTBEAT_MS });
  ctx.step('A sees that another account uses the vault');
  await ctx.shot(a, 'shared-banner');
}

// ---------- L2 ----------

async function graceEnds(ctx) {
  const { flows } = ctx;
  const { ua, ub, a, b, vault, lineage } = await ownerAndGuest(ctx, 'o2');
  await endGrace(ctx, lineage, ua, ub);
  const displaced = await waitForDisplaced(b, { timeoutMs: DISPLACED_MS });
  ctx.check(displaced.text.includes(S8_BODY), `B's open vault locks with S8: ${displaced.text.slice(0, 200)}`);
  ctx.check(!displaced.text.includes('Use here instead'), 'no [Use here instead] for a vault of another account');
  await ctx.shot(b, 'grace-ended-modal');
  await clickInDialog(b, displaced.title, 'OK');
  await flows.lockVault(b);

  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [NOT_OWNER_TITLE] }, 'B is refused with S4');
  ctx.check(res.text.includes(S4_BODY) && res.text.includes(`You're signed in as ${ub.email}.`), `S4 text: ${res.text.slice(0, 300)}`);
  await ctx.shot(b, 'not-owner-dialog');
  const copy = vaultIn(ctx, 'o2', 'Mine.conduit');
  await stubDialogs(b, { save: copy });
  await clickInDialog(b, NOT_OWNER_TITLE, 'Make my own copy');
  await waitForToast(b, 'Your copy is ready.', { timeoutMs: 30_000 });
  ctx.check(fs.existsSync(copy), 'the copy was saved next to the original');
  await ctx.waitFor(async () => (await dialogDetails(b)).length === 0, { timeoutMs: 10_000, label: 'S4 closed' });
  await cancelUnlockDialog(b).catch(() => {});
  await flows.openVault(b, copy, PW, { expect: 'unlocked' });
  await waitOwnership(ctx, b, 'owner', 15_000);
  ctx.step('B opened its own copy and owns it');
  await ctx.shot(b, 'own-copy-open');

  await flows.lockVault(a);
  await flows.openVault(a, vault, PW, { expect: 'unlocked' });
  await waitOwnership(ctx, a, 'owner', 15_000);
  ctx.step('A still opens the original');
}

// ---------- L3 ----------

async function releaseFromSettings(ctx, device) {
  // The backdated owner_since reaches the app with its next heartbeat (release_after).
  await ctx.waitFor(async () => {
    const o = (await ctx.ui.readSyncState(device))?.ownership ?? null;
    return o?.kind === 'owner' && o.releaseAfterMs !== null && o.releaseAfterMs <= Date.now();
  }, { timeoutMs: HEARTBEAT_MS, intervalMs: 1_000, label: `${device.name}: release allowed` });
  await openSettings(device, 'sync');
  const tab = await readSyncTab(device, { reopen: false });
  ctx.check(tab.text.includes('Owner: this account.'), `owner line: ${tab.text.slice(0, 400)}`);
  await ctx.ui.clickText(device, 'Release this vault...', { exact: true, selector: `${SELECTORS.settingsRoot.hook} button` });
  await waitForDialog(device, 'Release this vault?');
  await clickInDialog(device, 'Release this vault?', 'Release');
  await waitForToast(device, 'Vault released.', { timeoutMs: 20_000 });
  await cancelSettings(device);
}

async function releaseHandOver(ctx) {
  const { flows } = ctx;
  const { user: ua, devices: [a] } = await signedIn(ctx, 'pro', ['o3a']);
  const vault = vaultIn(ctx, 'o3');
  await flows.createVault(a, vault, PW);
  const lineage = await lineageOf(ctx, a);
  await ctx.sql("update public.personal_vault_owners set owner_since = owner_since - interval '8 days' where vault_key = :'k'", { k: lineage });
  await releaseFromSettings(ctx, a);
  const released = await ownerRow(ctx, lineage);
  ctx.check(released.owner_id === null && released.released_by === ua.id, `released (${JSON.stringify(released)})`);
  await ctx.waitFor(async () => ownerTagOf(vault, scratch(ctx))?.a === null, { timeoutMs: 30_000, label: 'the shared file carries {"a": null}' });
  await ctx.shot(a, 'released');
  await flows.lockVault(a);

  const { user: ub, devices: [b] } = await signedIn(ctx, 'pro', ['o3b']);
  await flows.openVault(b, vault, PW, { expect: 'unlocked' });
  ctx.checkEqual((await ownerRow(ctx, lineage)).owner_id, ub.id, 'the next account to open it owns it');

  const grace = await flows.openVault(a, vault, PW);
  ctx.checkEqual(grace.outcome, 'unlocked', 'A may still use it during grace');
  await flows.lockVault(a);
  await endGrace(ctx, lineage, ua, ub);
  const res = await flows.openVault(a, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [NOT_OWNER_TITLE] }, 'A is refused after grace');
  ctx.check(res.text.includes(S8B_BODY), `A sees the S8b body: ${res.text.slice(0, 300)}`);
  await ctx.shot(a, 'released-not-owner');
}

// ---------- L3b ----------

async function releaseSurvivesReacquire(ctx) {
  const { flows } = ctx;
  const { devices: [a1, a2] } = await signedIn(ctx, 'pro', ['o4a', 'o4b']);
  const vault = vaultIn(ctx, 'o4');
  await flows.createVault(a1, vault, PW);
  await flows.openVault(a2, vault, PW, { expect: 'unlocked' });
  const lineage = await lineageOf(ctx, a1);
  await ctx.sql("update public.personal_vault_owners set owner_since = owner_since - interval '8 days' where vault_key = :'k'", { k: lineage });
  await releaseFromSettings(ctx, a1);
  const u2 = deviceUuid(a2);
  await ctx.sql(
    "update public.personal_vault_sessions set expires_at = now() - interval '1 second' where vault_key = :'k' and device_id = :'d'",
    { k: lineage, d: u2 },
  );
  ctx.step('a2 lease expired by hand; its next heartbeat is lost and it re-acquires in the background');
  await ctx.waitFor(async () => {
    const rows = await ctx.sqlJson("select status, expires_at > now() as live from public.personal_vault_sessions where vault_key = :'k' and device_id = :'d'", { k: lineage, d: u2 });
    return rows[0]?.status === 'active' && rows[0]?.live ? rows[0] : null;
  }, { timeoutMs: HEARTBEAT_MS, intervalMs: 1_000, label: 'a2 re-acquired' });
  ctx.checkEqual((await ownerRow(ctx, lineage)).owner_id, null, 'a background re-acquire never claims the released vault');
  await waitOwnership(ctx, a2, 'unowned', HEARTBEAT_MS);
}

// ---------- L4 ----------

async function signedOutTag(ctx) {
  const { flows } = ctx;
  const { user: ua, devices: [a] } = await signedIn(ctx, 'pro', ['o5a']);
  const vault = vaultIn(ctx, 'o5');
  await flows.createVault(a, vault, PW);
  await ctx.waitFor(async () => (fs.existsSync(vault) ? ownerTagOf(vault, scratch(ctx))?.a : null), { timeoutMs: 30_000, label: 'owner tag in the shared file' });
  ctx.step(`owner tag written for ${ua.email}`);

  const b = await ctx.launchDevice('o5b');
  await flows.enterLocalMode(b);
  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: ['Sign in to open this vault'] }, 'a signed-out device of another account gets S6');
  await ctx.shot(b, 'sign-in-required');

  await flows.lockVault(a);
  await flows.signOut(a);
  await flows.enterLocalMode(a);
  await flows.openVault(a, vault, PW, { expect: 'unlocked' });
  ctx.step('the owner device opens its vault signed out (cached owner check)');
}

// ---------- L5 ----------

async function offlineOwner(ctx) {
  const { flows } = ctx;
  const proxyA = await ctx.supabaseProxy();
  const ua = await ctx.createUser('pro');
  const a = await ctx.launchDevice('o6a', { env: proxyA.env });
  await flows.signIn(a, ua);
  const vault = vaultIn(ctx, 'o6');
  await flows.createVault(a, vault, PW);
  await ctx.waitFor(async () => (fs.existsSync(vault) ? ownerTagOf(vault, scratch(ctx))?.a : null), { timeoutMs: 30_000, label: 'owner tag in the shared file' });
  await flows.lockVault(a);
  proxyA.cut();
  await flows.openVault(a, vault, PW, { expect: 'unlocked' });
  ctx.step('the owner opened its vault offline');

  const proxyB = await ctx.supabaseProxy();
  const ub = await ctx.createUser('pro');
  const b = await ctx.launchDevice('o6b', { env: proxyB.env });
  await flows.signIn(b, ub);
  proxyB.cut();
  const res = await flows.openVault(b, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: [NOT_OWNER_TITLE] }, 'another account offline gets S5');
  ctx.check(res.text.includes('Connect to the internet so Conduit can check who owns this vault'), `S5 text: ${res.text.slice(0, 200)}`);
  await ctx.shot(b, 'offline-not-owner');
  proxyA.restore();
  proxyB.restore();
}

// ---------- L6 ----------

async function deviceCap(ctx) {
  const { flows } = ctx;
  const { user, devices: [a] } = await signedIn(ctx, 'pro', ['o7a']);
  const vault = vaultIn(ctx, 'o7');
  await flows.createVault(a, vault, PW);
  await flows.lockVault(a);
  const fakes = [];
  for (let i = 1; i <= 5; i++) {
    const id = crypto.randomUUID();
    fakes.push(id);
    await ctx.sql(
      `insert into public.personal_vault_sessions (user_id, vault_key, device_id, lease_id, session_nonce, device_name, platform, app_version, expires_at, last_active_at)
       values (:'uid', gen_random_uuid(), :'dev', gen_random_uuid(), gen_random_uuid(), :'name', 'windows', '0.18.0', now() + interval '10 minutes', now() - make_interval(mins => :'age'::int))`,
      { uid: user.id, dev: id, name: `Fake PC ${i}`, age: String(60 - i) },
    );
  }
  ctx.step('five other devices of this account hold live leases');
  const res = await flows.openVault(a, vault, PW);
  ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: ['Too many devices'] }, 'S1 at unlock');
  ctx.check(res.text.includes("You're using Conduit on 5 devices. Close one to use it here."), `S1 text: ${res.text.slice(0, 300)}`);
  ctx.check(res.text.includes('Conduit will lock your vaults on Fake PC 1, the one you used least recently.'), 'S1 names the least recent device');
  await ctx.shot(a, 'too-many-devices');
  await useHereFromTakeover(a);
  const rows = await ctx.sqlJson("select status, displaced_reason from public.personal_vault_sessions where device_id = :'d'", { d: fakes[0] });
  ctx.checkEqual(rows, [{ status: 'displaced', displaced_reason: 'device_cap' }], 'the least recent device was displaced by the cap');
}

// ---------- L7 ----------

async function updateRequired(ctx) {
  const { flows } = ctx;
  const restore = () => ctx.sql("update public.app_config set value = :'v'::jsonb, updated_at = now() where key = 'min_app_version'", { v: MIN_VERSION_OFF });
  const stopAtRunEnd = ctx.run.onCleanup('reset min_app_version', restore);
  ctx.onClose('reset min_app_version', stopAtRunEnd);
  const { devices: [a] } = await signedIn(ctx, 'pro', ['o8a']);
  const vault = vaultIn(ctx, 'o8');
  await flows.createVault(a, vault, PW);
  await ctx.sql("update public.app_config set value = jsonb_set(value, '{desktop}', '\"99.0.0\"'), updated_at = now() where key = 'min_app_version'");
  ctx.step('min_app_version.desktop set to 99.0.0');
  try {
    const displaced = await waitForDisplaced(a, { timeoutMs: DISPLACED_MS });
    ctx.check(displaced.text.includes('Update Conduit to keep using this vault.') && displaced.text.includes('Update Conduit'), `S10: ${displaced.text.slice(0, 200)}`);
    await ctx.shot(a, 'update-required-modal');
    await clickInDialog(a, displaced.title, 'OK');
    await flows.lockVault(a);
    const res = await flows.openVault(a, vault, PW);
    ctx.checkEqual({ outcome: res.outcome, dialogs: res.dialogs }, { outcome: 'dialog', dialogs: ['Update required'] }, 'S9 at unlock');
    ctx.check(res.text.includes('Update to version 99.0.0 or later.'), `S9 text: ${res.text.slice(0, 200)}`);
    await ctx.shot(a, 'update-required-dialog');
  } finally {
    await restore();
  }
}

// ---------- L8 ----------

async function cloudBackupFree(ctx) {
  const { flows } = ctx;
  const { user, devices: [a] } = await signedIn(ctx, 'pro', ['o9a']);
  await flows.createVault(a, vaultIn(ctx, 'o9'), PW);
  await enableCloudBackup(a);
  await ctx.setTier(user.id, 'free');
  ctx.step('plan set to free with cloud backup on');

  const { accessToken } = await passwordSession(user);
  const res = await fetch(`${API_URL}/storage/v1/object/vaults/${user.id}/${crypto.randomUUID()}/vault.enc`, {
    method: 'POST',
    headers: { apikey: await getAnonKey(), Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('x'),
    signal: AbortSignal.timeout(15_000),
  });
  ctx.check(!res.ok, `the server refuses a Free upload (HTTP ${res.status})`);

  await cloudBackupSection(a);
  await ctx.ui.clickText(a, 'Back Up Now', { exact: true, selector: `${SELECTORS.settingsRoot.hook} button` });
  const section = await ctx.waitFor(async () => {
    const s = await cloudBackupSection(a);
    return s?.text.includes('Cloud backup needs Pro or Team. Your earlier backups are still here.') ? s : null;
  }, { timeoutMs: 30_000, intervalMs: 1_000, label: 'S16 in Settings > Backup' });
  ctx.check(section.text.includes('Upgrade'), 'S16 offers [Upgrade]');
  await ctx.shot(a, 'cloud-backup-refused');
}

export default {
  id: 'ownership',
  title: 'Vault ownership, device cap, minimum version and cloud backup plan gate',
  scenarios: [
    { id: 'owner-and-grace', title: 'The creator owns the vault; another account uses it during grace with the S7 banner; the owner sees S7b', run: ownerAndGrace },
    { id: 'grace-ends', title: 'After grace the guest is locked (S8) and refused (S4); it makes its own copy; the owner still opens', run: graceEnds },
    { id: 'release-hand-over', title: 'The owner releases in Sync settings; the next account owns it; the ex-owner gets S8b after grace', run: releaseHandOver },
    { id: 'release-survives-reacquire', title: 'A background re-acquire after a release never claims the vault', run: releaseSurvivesReacquire },
    { id: 'signed-out-tag', title: 'Signed out, the owner tag asks another account to sign in (S6); the owner opens with its cached check', run: signedOutTag },
    { id: 'offline-owner', title: 'Offline, the owner opens; another account gets S5', run: offlineOwner },
    { id: 'device-cap', title: 'A sixth device sees S1 and [Use here instead] displaces the least recent device', run: deviceCap },
    { id: 'update-required', title: 'A minimum version locks the open vault (S10) and refuses the unlock (S9)', run: updateRequired },
    { id: 'cloud-backup-free', title: 'The server refuses cloud backup on Free; the Backup tab shows S16', run: cloudBackupFree },
  ],
};
