// MCP tools against real devices: the tool list, no daily quota, writes that sync to a second
// device, the has_conflict flag, locked and open-elsewhere errors, and the MCP audit log.

import fs from 'node:fs';
import path from 'node:path';
import { evaluateIn } from '../lib/selectors.mjs';

const PASSWORD = 'verify-mcp-password-1';
const REQUIRED_TOOLS = ['entry_list', 'entry_info', 'entry_search', 'entry_update_notes', 'document_create', 'document_update', 'credential_list'];
const QUOTA_CALLS = 60;
const OLD_FREE_DAILY_QUOTA = 50;
// entry_list and entry_search allow 60 calls a minute with a burst of 10 (mcp/src/rate-limiter.ts).
const QUOTA_CALL_GAP_MS = 250;
const SYNC_DEADLINE_MS = 30_000;
const TAKEOVER_TITLE = 'Vault open on another device';
const OPEN_ELSEWHERE = 'open_elsewhere';
const VAULT_LOCKED = 'VAULT_LOCKED';

/** Every tool call made through tracked clients, in order, for the audit scenario. */
const auditTrail = [];

function auditLogPath(device) {
  return path.join(device.home, '.config', 'conduit', 'audit.log');
}

function outcomeOf(res) {
  if (!res.isError) return 'success';
  return /Rate limit exceeded/.test(res.text) ? 'rate_limited' : 'error';
}

/** An MCP client whose calls land in auditTrail. call() throws on a tool error. */
async function trackedMcp(ctx, device) {
  const mcp = await ctx.connectMcp(device);
  const auditPath = auditLogPath(device);
  async function callRaw(tool, args = {}) {
    try {
      const res = await mcp.callToolRaw(tool, args);
      auditTrail.push({ device: device.name, auditPath, tool, outcome: outcomeOf(res) });
      return res;
    } catch (err) {
      auditTrail.push({ device: device.name, auditPath, tool, outcome: 'unknown' });
      throw err;
    }
  }
  async function call(tool, args) {
    const res = await callRaw(tool, args);
    if (res.isError) throw new Error(`${device.name}: MCP ${tool} failed: ${res.text.slice(0, 400)}`);
    return res.data;
  }
  return { listTools: mcp.listTools, callRaw, call };
}

async function signedInDevices(ctx, user, names) {
  const devices = await Promise.all(names.map((n) => ctx.launchDevice(n)));
  await Promise.all(devices.map((d) => ctx.flows.waitForScreen(d, 'auth')));
  const who = await Promise.all(devices.map((d) => ctx.flows.signIn(d, user)));
  for (const w of who) ctx.checkEqual(w, { email: user.email, tier: user.role }, 'device is signed in as the test user');
  ctx.step(`${names.join(', ')} signed in as ${user.role} user ${user.email}`);
  return devices;
}

async function createSharedVault(ctx, device, fileName) {
  const vaultPath = path.join(ctx.cloudDir, fileName);
  await ctx.flows.createVault(device, vaultPath, PASSWORD);
  const sync = await ctx.ui.readSyncState(device);
  ctx.check(sync.vault?.shared === true, `${fileName} counts as a shared personal vault (sync.vault=${JSON.stringify(sync.vault)})`);
  ctx.step(`${device.name} created ${fileName}`);
  return vaultPath;
}

/** A Pro user with the same vault unlocked on two devices, and an entry both of them see. */
async function proPair(ctx, [nameA, nameB], fileName, entryFields) {
  const user = await ctx.createUser('pro');
  const [a, b] = await signedInDevices(ctx, user, [nameA, nameB]);
  const vaultPath = await createSharedVault(ctx, a, fileName);
  const entry = await ctx.flows.addEntry(a, entryFields);
  ctx.check(typeof entry?.id === 'string', 'entry_create on a returned an id');
  await ctx.flows.openVault(b, vaultPath, PASSWORD, { expect: 'unlocked' });
  await ctx.waitFor(async () => (await ctx.flows.listEntries(b)).some((e) => e.id === entry.id), {
    timeoutMs: SYNC_DEADLINE_MS,
    label: `${nameB} sees ${entry.name}`,
  });
  ctx.step(`${nameB} opened the vault and sees "${entry.name}"`);
  return { user, a, b, vaultPath, entry };
}

function waitUpToDate(ctx, device) {
  return ctx.waitFor(async () => (await ctx.ui.readSyncState(device)).status?.kind === 'up-to-date', {
    timeoutMs: SYNC_DEADLINE_MS,
    label: `${device.name}: sync status up to date`,
  });
}

/** Files called `name` under `root`; symlinks are not followed (launcher/mcp points into the repo). */
function findFiles(root, name) {
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === name) found.push(full);
    }
  };
  walk(root);
  return found;
}

async function toolsList(ctx) {
  const user = await ctx.createUser('free');
  const [device] = await signedInDevices(ctx, user, ['m1']);
  await createSharedVault(ctx, device, 'McpTools.conduit');
  const mcp = await trackedMcp(ctx, device);
  const tools = await mcp.listTools();
  const names = tools.map((t) => t.name);
  const missing = REQUIRED_TOOLS.filter((t) => !names.includes(t));
  ctx.checkEqual(missing, [], `tools/list has every vault tool (got ${names.length} tools)`);
  for (const t of tools.filter((x) => REQUIRED_TOOLS.includes(x.name))) {
    ctx.check(t.inputSchema?.type === 'object', `${t.name} has an object input schema`);
  }
  const listed = await mcp.call('entry_list', {});
  ctx.check(Array.isArray(listed?.entries), `entry_list works on the unlocked vault: ${JSON.stringify(listed).slice(0, 200)}`);
  ctx.step(`tools/list: ${names.length} tools, all ${REQUIRED_TOOLS.length} vault tools present`);
}

async function noDailyQuota(ctx) {
  const { flows } = ctx;
  const user = await ctx.createUser('free');
  const [device] = await signedInDevices(ctx, user, ['m2']);
  await createSharedVault(ctx, device, 'McpQuota.conduit');
  const entries = [];
  for (const name of ['quota-alpha', 'quota-beta', 'quota-gamma']) entries.push(await flows.addEntry(device, { name }));
  const mcp = await trackedMcp(ctx, device);

  const callFor = (i) => {
    if (i % 3 === 0) return ['entry_list', {}];
    if (i % 3 === 1) return ['entry_search', { query: 'quota' }];
    return ['entry_info', { entry_id: entries[i % entries.length].id }];
  };
  const refused = [];
  for (let i = 0; i < QUOTA_CALLS; i++) {
    const [tool, args] = callFor(i);
    const res = await mcp.callRaw(tool, args);
    if (res.isError) refused.push(`#${i + 1} ${tool}: ${res.text.slice(0, 200)}`);
    else if (tool === 'entry_info') ctx.checkEqual(res.data.id, args.entry_id, `call ${i + 1}: entry_info answers for the asked entry`);
    else ctx.check(res.data.entries.length >= entries.length, `call ${i + 1}: ${tool} lists the test entries`);
    await ctx.sleep(QUOTA_CALL_GAP_MS);
  }
  ctx.checkEqual(refused, [], `all ${QUOTA_CALLS} calls succeed on the Free plan (the old cap was ${OLD_FREE_DAILY_QUOTA} a day)`);
  ctx.step(`${QUOTA_CALLS} MCP calls as a Free user, none refused`);

  const mcpDataDir = path.dirname(device.socketPath);
  ctx.check(fs.existsSync(mcpDataDir) && fs.existsSync(device.dataDir), 'the MCP and app data dirs exist, so the search below is not empty-handed');
  const quotaFiles = [...findFiles(device.root, 'mcp-quota.json'), ...findFiles(ctx.cloudDir, 'mcp-quota.json')];
  ctx.checkEqual(quotaFiles, [], `no mcp-quota.json under ${device.root} (HOME and app data) or the cloud folder`);
}

async function writesSync(ctx) {
  const { flows, ui } = ctx;
  const { a, b, entry } = await proPair(ctx, ['m3a', 'm3b'], 'McpSync.conduit', { name: 'MCP sync target', host: '10.30.0.1' });
  const mcp = await trackedMcp(ctx, a);
  const notes = `Notes written by MCP in run ${ctx.runId}`;
  const docName = `MCP doc ${ctx.run.shortId}`;
  const docV1 = '# Draft\n\nfirst version';
  const docV2 = '# Runbook\n\nsecond version from MCP';

  const noted = await mcp.call('entry_update_notes', { entry_id: entry.id, notes });
  ctx.checkEqual(noted.id, entry.id, 'entry_update_notes answers for the entry');
  const doc = await mcp.call('document_create', { name: docName, content: docV1 });
  ctx.check(typeof doc?.id === 'string', `document_create returned an id: ${JSON.stringify(doc)}`);
  await mcp.call('document_update', { entry_id: doc.id, content: docV2 });
  const wroteAt = Date.now();
  ctx.step(`MCP on m3a: notes on ${entry.id}, created and updated document ${doc.id}`);

  const onA = await ui.invoke(a, 'entry_get', { id: entry.id });
  ctx.checkEqual(onA.notes, notes, 'm3a entry store (IPC entry_get) has the MCP notes');
  const docOnA = await ui.invoke(a, 'entry_get', { id: doc.id });
  ctx.checkEqual([docOnA.name, docOnA.entry_type, docOnA.config?.content], [docName, 'document', docV2], 'm3a entry store has the MCP document');
  await ui.waitForText(a, docName, { timeoutMs: 15_000 });
  ctx.step('m3a renderer reloaded its entry list and shows the new document');

  await ctx.waitFor(async () => {
    const [e, d] = await Promise.all([ui.invoke(b, 'entry_get', { id: entry.id }), ui.invoke(b, 'entry_get', { id: doc.id })]);
    return e.notes === notes && d.name === docName && d.config?.content === docV2;
  }, { timeoutMs: SYNC_DEADLINE_MS, intervalMs: 500, label: 'm3b receives the MCP notes and document' });
  ctx.step(`m3b received all three MCP writes ${((Date.now() - wroteAt) / 1000).toFixed(1)} s after the last one`);
  await flows.refreshEntries(b);
  await ui.waitForText(b, docName, { timeoutMs: 15_000 });
  await ctx.shot(b, 'mcp-writes-synced');
}

async function hasConflictFlag(ctx) {
  const { flows, ui } = ctx;
  const { a, b, entry } = await proPair(ctx, ['m4a', 'm4b'], 'McpConflict.conduit', { name: 'MCP conflict target', host: '10.40.0.1' });
  await Promise.all([waitUpToDate(ctx, a), waitUpToDate(ctx, b)]);
  const [mcpA, mcpB] = await Promise.all([trackedMcp(ctx, a), trackedMcp(ctx, b)]);
  const before = await mcpA.call('entry_info', { entry_id: entry.id });
  ctx.checkEqual(before.has_conflict, false, 'entry_info has_conflict is false before the concurrent edits');

  await Promise.all([flows.updateEntry(a, entry.id, { host: '10.40.0.11' }), flows.updateEntry(b, entry.id, { host: '10.40.0.22' })]);
  ctx.step('m4a and m4b changed Host at the same time (10.40.0.11 and 10.40.0.22)');
  const flagged = await ctx.waitFor(async () => {
    const info = await mcpA.call('entry_info', { entry_id: entry.id });
    return info.has_conflict === true ? info : null;
  }, { timeoutMs: 60_000, intervalMs: 1_000, label: 'entry_info has_conflict: true on m4a' });
  ctx.check(['10.40.0.11', '10.40.0.22'].includes(flagged.host), `entry_info shows one of the two hosts as the provisional value (${flagged.host})`);
  ctx.step(`MCP entry_info on m4a: has_conflict true, provisional host ${flagged.host}`);

  await flows.openConflictReview(a);
  await ui.waitForText(a, 'Use this', { timeoutMs: 15_000 });
  await ctx.shot(a, 'review-panel');
  const chosen = await useVersionNotInUse(ctx, a);
  ctx.check(chosen !== null && chosen !== flagged.host, `picked the version that is not in use (${chosen})`);
  await ui.waitForText(a, 'Nothing to review', { timeoutMs: 15_000 });
  ctx.step(`resolved the Host conflict in the review panel with "Use this" on ${chosen}`);

  const after = await mcpA.call('entry_info', { entry_id: entry.id });
  ctx.checkEqual([after.has_conflict, after.host], [false, chosen], 'entry_info on m4a: no conflict, the chosen host');
  await ctx.waitFor(async () => {
    const info = await mcpB.call('entry_info', { entry_id: entry.id });
    return info.has_conflict === false && info.host === chosen;
  }, { timeoutMs: SYNC_DEADLINE_MS, intervalMs: 1_000, label: 'entry_info on m4b: no conflict, the chosen host' });
  ctx.step('m4b also reports has_conflict false and the chosen host after the resolution synced');
}

/** In-page: clicks "Use this" on the version without the "In use now" badge; returns that version's text. */
export function pickVersionNotInUseInPage(_, cv) {
  const panel = document.querySelector('[role=dialog][aria-label="Review changes"]');
  if (!panel) return null;
  const buttons = [...panel.querySelectorAll('button')].filter((b) => b.innerText.trim() === 'Use this');
  const row = buttons.map((b) => ({ b, row: cv.pickClosest(b, panel, cv.S.reviewVersion) })).find(({ row }) => row && !row.innerText.includes('In use now'));
  if (!row) return null;
  const value = cv.pickOne(row.row, cv.S.reviewValue)?.innerText.trim() ?? null;
  row.b.click();
  return value;
}

function useVersionNotInUse(ctx, device) {
  return evaluateIn(device, pickVersionNotInUseInPage, null, { label: 'pick a version' });
}

function lockedError(res) {
  return res.isError && res.data?.code === VAULT_LOCKED ? res.data : null;
}

async function lockedAndElsewhere(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('free');
  const [a, b] = await signedInDevices(ctx, user, ['m5a', 'm5b']);
  const vaultPath = await createSharedVault(ctx, a, 'McpLocked.conduit');
  const mcp = await trackedMcp(ctx, a);
  await mcp.call('entry_list', {});

  await flows.lockVault(a);
  const locked = lockedError(await mcp.callRaw('entry_list', {}));
  ctx.check(locked !== null, 'entry_list on a locked vault returns the VAULT_LOCKED error');
  ctx.check(locked.reason === undefined, `a manual lock has no open_elsewhere reason (${JSON.stringify(locked)})`);
  ctx.step(`locked m5a: ${JSON.stringify(locked)}`);

  await flows.openVault(a, vaultPath, PASSWORD, { expect: 'unlocked' });
  await mcp.call('entry_list', {});
  ctx.step('unlocked m5a again; entry_list works');

  const res = await flows.openVault(b, vaultPath, PASSWORD);
  ctx.check(res.outcome === 'dialog' && res.dialogs.includes(TAKEOVER_TITLE), `m5b is offered a take-over (${JSON.stringify(res.dialogs ?? res.outcome)})`);
  await ui.clickText(b, 'Use here instead', { exact: true, selector: 'button' });
  await ctx.waitFor(async () => (await ui.invoke(b, 'vault_is_unlocked')) && !(await flows.openDialogs(b)).includes(TAKEOVER_TITLE), {
    timeoutMs: 60_000,
    label: 'm5b unlocked after "Use here instead"',
  });
  ctx.step('m5b took the vault over');

  const elsewhere = await ctx.waitFor(async () => {
    const err = lockedError(await mcp.callRaw('credential_list', {}));
    return err?.reason === OPEN_ELSEWHERE ? err : null;
  }, { timeoutMs: 60_000, intervalMs: 1_500, label: `m5a MCP error with reason ${OPEN_ELSEWHERE}` });
  ctx.step(`m5a after the take-over: ${JSON.stringify(elsewhere)}`);
  await ctx.waitFor(async () => (await flows.openDialogs(a)).some((t) => t.startsWith('Opened on ')), {
    timeoutMs: 15_000,
    label: 'm5a shows the displaced dialog',
  });
  await ctx.shot(a, 'displaced');
}

function readAudit(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** auditTrail grouped by audit log file (one per device HOME). */
function trailsByLog() {
  const byLog = new Map();
  for (const call of auditTrail) byLog.set(call.auditPath, [...(byLog.get(call.auditPath) ?? []), call]);
  return byLog;
}

async function auditLog(ctx) {
  const { flows } = ctx;
  const device = await ctx.launchDevice('m6');
  await flows.enterLocalMode(device);
  await flows.createVault(device, path.join(ctx.cloudDir, 'McpAudit.conduit'), PASSWORD);
  const mcp = await trackedMcp(ctx, device);
  const probeKey = `probe-${ctx.run.shortId}-not-a-real-key`;
  await mcp.call('entry_search', { query: 'audit-probe', api_key: probeKey });
  const missing = await mcp.callRaw('entry_info', { entry_id: 'no-such-entry' });
  ctx.check(missing.isError, 'entry_info on an unknown id fails');
  await flows.lockVault(device);
  ctx.check(lockedError(await mcp.callRaw('entry_list', {})) !== null, 'entry_list on the locked vault fails with VAULT_LOCKED');

  const own = readAudit(auditLogPath(device));
  ctx.check(own.length === 3, `the MCP audit log (${auditLogPath(device)}) has the 3 calls: ${JSON.stringify(own).slice(0, 600)}`);
  ctx.checkEqual(own[0].parameters, { query: 'audit-probe', api_key: '[REDACTED]' }, 'secret-looking parameters are redacted');
  ctx.check(!fs.readFileSync(auditLogPath(device), 'utf8').includes(probeKey), 'the probe key value never reaches the audit log');
  ctx.checkEqual([own[1].result.type, own[2].result.type], ['error', 'error'], 'failed calls are logged as errors');
  ctx.check(own[2].result.message.includes(VAULT_LOCKED), `the locked call's audit message names ${VAULT_LOCKED}`);
  for (const e of own) {
    ctx.check(e.client === 'mcp-client' && Number.isFinite(e.duration_ms) && !Number.isNaN(Date.parse(e.timestamp)), `audit line is well formed: ${JSON.stringify(e)}`);
  }

  let checked = 0;
  for (const [file, calls] of trailsByLog()) {
    const name = calls[0].device;
    if (calls.some((c) => c.outcome === 'unknown')) {
      ctx.step(`${name}: skipped, a call timed out so its outcome is unknown`);
      continue;
    }
    const logged = readAudit(file).map((e) => ({ tool: e.tool, outcome: e.result.type }));
    ctx.checkEqual(logged, calls.map((c) => ({ tool: c.tool, outcome: c.outcome })), `${name}: the audit log matches every MCP call made on it`);
    checked += calls.length;
    ctx.step(`${name}: ${calls.length} calls, all in ${path.relative(ctx.run.tmpRoot, file)}`);
  }
  ctx.step(`${checked} MCP calls across this run are in the audit logs`);
}

export default {
  id: 'mcp',
  title: 'MCP tools on real devices',
  scenarios: [
    { id: 'tools-list', title: 'Free user with an unlocked vault: tools/list has the vault tools', run: toolsList },
    { id: 'no-daily-quota', title: `Free user: ${QUOTA_CALLS} tool calls, none refused, no mcp-quota.json`, run: noDailyQuota },
    { id: 'writes-sync', title: 'Pro user: MCP notes and document writes show on the device and reach a second device', run: writesSync },
    { id: 'has-conflict', title: 'Pro user: a same-field conflict sets has_conflict until it is resolved in the review panel', run: hasConflictFlag },
    { id: 'locked-and-elsewhere', title: 'Locked vault error, then open_elsewhere after a Free take-over', run: lockedAndElsewhere },
    { id: 'audit', title: 'Every MCP call of the run is in the MCP audit log, secrets redacted', run: auditLog },
  ],
};
