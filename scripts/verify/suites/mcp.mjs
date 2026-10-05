// MCP tools against real devices: the tool list, no daily quota, writes that sync to a second
// device, the has_conflict flag, locked and open-elsewhere errors, and the MCP audit log.

import fs from 'node:fs';
import path from 'node:path';
import { evaluateIn } from '../lib/selectors.mjs';
import { setSidebar } from '../lib/restyle-data.mjs';

const PASSWORD = 'verify-mcp-password-1';
const REQUIRED_TOOLS = ['entry_list', 'entry_info', 'entry_search', 'entry_update_notes', 'entry_edit_notes', 'document_create', 'document_update', 'credential_list'];
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
  const firstNotes = `Notes written by MCP in run ${ctx.runId}\nadmin: !!mcp-verify-secret!!`;
  const notes = firstNotes.replace('written by MCP', 'edited by MCP');
  const docName = `MCP doc ${ctx.run.shortId}`;
  const docV1 = '# Draft\n\nfirst version';
  const docV2 = '# Runbook\n\nsecond version from MCP';

  const noted = await mcp.call('entry_update_notes', { entry_id: entry.id, notes: firstNotes });
  ctx.checkEqual(noted.id, entry.id, 'entry_update_notes answers for the entry');
  const info = await mcp.call('entry_info', { entry_id: entry.id, include_notes: true });
  ctx.check(info.notes.includes('admin: [SECRET_1]') && !info.notes.includes('mcp-verify-secret'), `entry_info shows the secret as a token: ${info.notes}`);
  const edited = await mcp.call('entry_edit_notes', {
    entry_id: entry.id,
    edits: [{ old_string: 'Notes written by MCP', new_string: 'Notes edited by MCP' }],
  });
  ctx.checkEqual([edited.replacements, edited.secrets_removed], [1, 0], 'entry_edit_notes changed one line and kept the secret');
  const doc = await mcp.call('document_create', { name: docName, content: docV1 });
  ctx.check(typeof doc?.id === 'string', `document_create returned an id: ${JSON.stringify(doc)}`);
  await mcp.call('document_update', { entry_id: doc.id, content: docV2 });
  const wroteAt = Date.now();
  ctx.step(`MCP on m3a: wrote and edited notes on ${entry.id}, created and updated document ${doc.id}`);

  const onA = await ui.invoke(a, 'entry_get', { id: entry.id });
  ctx.checkEqual(onA.notes, notes, 'm3a entry store (IPC entry_get) has the edited MCP notes with the secret intact');
  const docOnA = await ui.invoke(a, 'entry_get', { id: doc.id });
  ctx.checkEqual([docOnA.name, docOnA.entry_type, docOnA.config?.content], [docName, 'document', docV2], 'm3a entry store has the MCP document');
  // Home no longer lists recent entries and test windows start with the side bar hidden, so the entry tree is the place to look.
  await setSidebar(a, 'docked');
  await ui.waitForText(a, docName, { timeoutMs: 15_000 });
  ctx.step('m3a renderer reloaded its entry list and shows the new document');

  await ctx.waitFor(async () => {
    const [e, d] = await Promise.all([ui.invoke(b, 'entry_get', { id: entry.id }), ui.invoke(b, 'entry_get', { id: doc.id })]);
    return e.notes === notes && d.name === docName && d.config?.content === docV2;
  }, { timeoutMs: SYNC_DEADLINE_MS, intervalMs: 500, label: 'm3b receives the MCP notes and document' });
  ctx.step(`m3b received all four MCP writes ${((Date.now() - wroteAt) / 1000).toFixed(1)} s after the last one`);
  await flows.refreshEntries(b);
  await setSidebar(b, 'docked');
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

const SESSION_IN_USE = 'SESSION_IN_USE';

function ownerIn(list, sessionId) {
  return list.connections.find((c) => c.id === sessionId) ?? null;
}

/** Two MCP processes are two agents: neither may act in a session the other is working in. */
async function twoAgents(ctx) {
  const { flows, ui } = ctx;
  const device = await ctx.launchDevice('m7');
  await flows.enterLocalMode(device);
  await flows.createVault(device, path.join(ctx.cloudDir, 'McpAgents.conduit'), PASSWORD);
  const a = await ctx.connectMcp(device);
  const b = await ctx.connectMcp(device);

  const { session_id: shellA } = await a.callTool('local_shell_create', {});
  const ranA = await a.callToolRaw('terminal_execute', { connection_id: shellA, command: 'echo agent-a-ran' });
  ctx.check(!ranA.isError && ranA.text.includes('agent-a-ran'), `agent A runs a command in its own shell: ${ranA.text.slice(0, 200)}`);
  ctx.step(`agent A opened ${shellA.slice(0, 8)} and ran a command in it`);

  const seenByA = ownerIn(await a.callTool('connection_list', {}), shellA);
  const seenByB = ownerIn(await b.callTool('connection_list', {}), shellA);
  ctx.checkEqual([seenByA?.owner, seenByB?.owner], ['you', 'other_agent'], 'connection_list shows the shell as A\'s to A and as another agent\'s to B');
  ctx.check(/local_shell_create/.test(seenByB?.note ?? ''), `B's list tells it to open its own session: ${seenByB?.note}`);

  const refused = await b.callToolRaw('terminal_execute', { connection_id: shellA, command: 'echo agent-b-intrudes' });
  ctx.check(refused.isError && refused.data?.code === SESSION_IN_USE, `agent B is refused in A's shell: ${refused.text.slice(0, 300)}`);
  const keys = await b.callToolRaw('terminal_send_keys', { connection_id: shellA, keys: 'x' });
  ctx.check(keys.isError && keys.data?.code === SESSION_IN_USE, 'agent B cannot send keys to A\'s shell');
  const read = await b.callToolRaw('terminal_read_pane', { connection_id: shellA });
  ctx.check(!read.isError && !read.text.includes('agent-b-intrudes'), 'agent B can still read A\'s shell, and its command never ran there');
  ctx.step(`agent B refused with ${SESSION_IN_USE}; reading still works`);

  const { session_id: shellB } = await b.callTool('local_shell_create', {});
  const ranB = await b.callToolRaw('terminal_execute', { connection_id: shellB, command: 'echo agent-b-ran' });
  ctx.check(!ranB.isError && ranB.text.includes('agent-b-ran'), 'agent B works in a shell of its own');
  const crossed = await a.callToolRaw('terminal_execute', { connection_id: shellB, command: 'echo nope' });
  ctx.check(crossed.isError && crossed.data?.code === SESSION_IN_USE, 'agent A is refused in B\'s shell');
  ctx.step(`agent B opened ${shellB.slice(0, 8)} and works there; A is refused in it`);

  const userShell = await ui.invoke(device, 'local_shell_create', {});
  ctx.check(ownerIn(await a.callTool('connection_list', {}), userShell)?.owner === 'free', 'a shell the user opened is free');
  await ui.invoke(device, 'terminal_close', { sessionId: userShell });

  await a.close();
  await ctx.waitFor(async () => {
    const res = await b.callToolRaw('terminal_execute', { connection_id: shellA, command: 'echo b-after-a-left' });
    return !res.isError && res.text.includes('b-after-a-left');
  }, { timeoutMs: 15_000, intervalMs: 500, label: 'agent B can use A\'s shell once A exits' });
  await b.callTool('connection_close', { connection_id: shellA });
  ctx.step('after agent A exited, B used and closed its old shell');
}

// Secrets the agent must never see. Stored notes keep them; MCP output, errors and the audit log must not.
const NOTE_SECRETS = ['verify-root-pw-7731', 'verify-db-pw-4402', 'verify-api-key-9915'];
// Notes writes allow 30 calls a minute with a burst of 5 (mcp/src/rate-limiter.ts).
const NOTES_WRITE_GAP_MS = 2_100;
const NOTES_V1 = [
  '## Access',
  `root: !!${NOTE_SECRETS[0]}!!`,
  'port: 22',
  '',
  '## Database',
  `postgres: !!${NOTE_SECRETS[1]}!!`,
  'version: 15',
  '',
  '## Log',
  '- nginx reloaded',
  '- nginx upgraded',
].join('\n');

/** The notes pane's text outside blurred secret spans, and the blurred spans' text (SecretSpan keeps the value in the DOM, blurred). */
export function readNotesPaneInPage() {
  const pane = [...document.querySelectorAll('.prose, [class*=prose]')].find((el) => /root:/.test(el.textContent ?? ''));
  if (!pane) return null;
  const blurred = [...pane.querySelectorAll('.blur-sm')].map((el) => el.textContent ?? '');
  const copy = pane.cloneNode(true);
  for (const el of copy.querySelectorAll('.blur-sm')) el.remove();
  return { visible: copy.textContent ?? '', blurred };
}

export function openEntryDashboardInPage(id) {
  return import('/src/lib/openDashboard.ts').then((m) => {
    m.openDashboardForEntry(id);
    return true;
  });
}

async function notesSecrets(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('free');
  const [device] = await signedInDevices(ctx, user, ['m8']);
  await createSharedVault(ctx, device, 'McpNotes.conduit');
  const entry = await flows.addEntry(device, { name: 'Notes edit target', host: '10.60.0.1' });
  await flows.updateEntry(device, entry.id, { notes: NOTES_V1 });
  const mcp = await trackedMcp(ctx, device);
  const stored = async () => (await ui.invoke(device, 'entry_get', { id: entry.id })).notes;
  const noSecretIn = (label, text) => {
    const leaked = NOTE_SECRETS.filter((v) => text.includes(v));
    ctx.checkEqual(leaked, [], `${label} shows no secret value`);
  };
  ctx.step('m8: entry with two !!secret!! values in its notes, set through the app');

  // 1. Reads show numbered tokens and never the values.
  const info = await mcp.callRaw('entry_info', { entry_id: entry.id, include_notes: true });
  noSecretIn('entry_info', info.text);
  ctx.checkEqual(info.data.notes, NOTES_V1.replace(`!!${NOTE_SECRETS[0]}!!`, '[SECRET_1]').replace(`!!${NOTE_SECRETS[1]}!!`, '[SECRET_2]'), 'entry_info shows [SECRET_1] and [SECRET_2]');

  // 2. A one-line edit leaves the secrets in place.
  let want = NOTES_V1.replace('port: 22', 'port: 2222');
  const one = await mcp.call('entry_edit_notes', { entry_id: entry.id, edits: [{ old_string: 'port: 22', new_string: 'port: 2222' }] });
  ctx.checkEqual([one.replacements, one.secrets_removed], [1, 0], 'one-line edit: 1 replacement, no secret removed');
  ctx.checkEqual(await stored(), want, 'stored notes: port changed, both secrets intact');
  ctx.step('edited one line; the stored secrets did not change');

  // 3. Reword the line that holds a secret by reusing its token.
  want = want.replace('root: !!', 'root (sudo only): !!');
  await mcp.call('entry_edit_notes', { entry_id: entry.id, edits: [{ old_string: 'root: [SECRET_1]', new_string: 'root (sudo only): [SECRET_1]' }] });
  ctx.checkEqual(await stored(), want, 'stored notes: reworded secret line keeps the real password');

  // 4. Several edits in one call: move the Database section above Access (tokens travel with it),
  //    replace_all on a repeated word, and add a new secret the user gave the agent.
  const access = 'root (sudo only): [SECRET_1]\nport: 2222\n\n';
  const multi = await mcp.call('entry_edit_notes', {
    entry_id: entry.id,
    edits: [
      { old_string: `## Access\n${access}## Database\npostgres: [SECRET_2]\nversion: 15\n`, new_string: `## Database\npostgres: [SECRET_2]\nversion: 16\n\n## Access\n${access.trimEnd()}\n` },
      { old_string: 'nginx', new_string: 'caddy', replace_all: true },
      { old_string: '- caddy upgraded', new_string: `- caddy upgraded\n- api key: !!${NOTE_SECRETS[2]}!!` },
    ],
  });
  ctx.checkEqual([multi.replacements, multi.secrets_removed], [4, 0], 'multi-edit: 4 replacements, no secret removed');
  want = [
    '## Database', `postgres: !!${NOTE_SECRETS[1]}!!`, 'version: 16', '',
    '## Access', `root (sudo only): !!${NOTE_SECRETS[0]}!!`, 'port: 2222', '',
    '## Log', '- caddy reloaded', '- caddy upgraded', `- api key: !!${NOTE_SECRETS[2]}!!`,
  ].join('\n');
  ctx.checkEqual(await stored(), want, 'stored notes: section moved with its secret, words replaced, new secret added');
  const reread = await mcp.callRaw('entry_info', { entry_id: entry.id, include_notes: true });
  noSecretIn('entry_info after the edits', reread.text);
  ctx.check(/postgres: \[SECRET_1\][\s\S]*root \(sudo only\): \[SECRET_2\][\s\S]*api key: \[SECRET_3\]/.test(reread.data.notes), `tokens renumber by position: ${reread.data.notes}`);
  ctx.step('one call moved a section, replaced every "nginx" and added a new secret; all three secrets correct');

  // 5. Refused writes change nothing and leak nothing.
  const refused = [
    ['old text not found', 'entry_edit_notes', { edits: [{ old_string: 'version: 99', new_string: 'x' }] }, /not found/],
    ['old text matches twice', 'entry_edit_notes', { edits: [{ old_string: 'caddy', new_string: 'x' }] }, /matches 2 places/],
    ['bare [REDACTED] marker', 'entry_edit_notes', { edits: [{ old_string: 'postgres: [SECRET_1]', new_string: 'postgres: [REDACTED]' }] }, /\[REDACTED\]/],
    ['token not in the notes', 'entry_edit_notes', { edits: [{ old_string: 'port: 2222', new_string: 'port: [SECRET_9]' }] }, /SECRET_9/],
    ['token inside !! markers', 'entry_edit_notes', { edits: [{ old_string: 'postgres: [SECRET_1]', new_string: 'postgres: !!x [SECRET_1]!!' }] }, /stand on its own/],
    ['edits is not a list', 'entry_edit_notes', { edits: 'port: 2222' }, /edits must be/],
    ['second of two edits fails', 'entry_edit_notes', { edits: [{ old_string: 'port: 2222', new_string: 'port: 1' }, { old_string: 'nope', new_string: 'x' }] }, /edit 2/],
    ['full rewrite with [REDACTED]', 'entry_update_notes', { notes: 'root: [REDACTED]' }, /\[REDACTED\]/],
  ];
  for (const [label, tool, args, pattern] of refused) {
    await ui.sleep(NOTES_WRITE_GAP_MS);
    const res = await mcp.callRaw(tool, { entry_id: entry.id, ...args });
    ctx.check(res.isError && pattern.test(res.text), `${label}: refused (${res.text.slice(0, 160)})`);
    noSecretIn(`${label} error`, res.text);
  }
  ctx.checkEqual(await stored(), want, 'stored notes unchanged after every refused write');
  ctx.step(`${refused.length} bad writes refused; the stored notes did not change`);

  // 6. Full rewrite keeps tokens and reports a dropped secret.
  const rewrite = await mcp.call('entry_update_notes', { entry_id: entry.id, notes: '## Summary\nroot: [SECRET_2]\napi: [SECRET_3]' });
  ctx.checkEqual(rewrite.secrets_removed, 1, 'entry_update_notes reports the one secret it dropped');
  want = `## Summary\nroot: !!${NOTE_SECRETS[0]}!!\napi: !!${NOTE_SECRETS[2]}!!`;
  ctx.checkEqual(await stored(), want, 'stored notes after full rewrite: kept secrets have their real values');

  // 7. An entry with no notes takes an empty old_string.
  const blank = await flows.addEntry(device, { name: 'Notes blank target', host: '10.60.0.2' });
  await ui.sleep(NOTES_WRITE_GAP_MS);
  await mcp.call('entry_edit_notes', { entry_id: blank.id, edits: [{ old_string: '', new_string: '# Fresh notes' }] });
  ctx.checkEqual((await ui.invoke(device, 'entry_get', { id: blank.id })).notes, '# Fresh notes', 'empty notes filled through entry_edit_notes');

  // 8. Documents round-trip their secrets the same way.
  const doc = await mcp.call('document_create', { name: `Notes doc ${ctx.run.shortId}`, content: `API key: !!${NOTE_SECRETS[2]}!!` });
  const read = await mcp.callRaw('document_read', { entry_id: doc.id });
  noSecretIn('document_read', read.text);
  ctx.checkEqual(read.data.content, 'API key: [SECRET_1]', 'document_read shows the token');
  await mcp.call('document_update', { entry_id: doc.id, content: `${read.data.content}\nRotated: 2026-10` });
  ctx.checkEqual((await ui.invoke(device, 'entry_get', { id: doc.id })).config?.content, `API key: !!${NOTE_SECRETS[2]}!!\nRotated: 2026-10`, 'document_update kept the real secret');
  ctx.step('blank notes filled; document secret survived read and update');

  // 9. The app shows the edited notes with the secrets masked.
  await flows.refreshEntries(device);
  await evaluateIn(device, openEntryDashboardInPage, entry.id, { label: 'open entry info' });
  await ui.waitForText(device, 'Summary', { timeoutMs: 15_000 });
  const pane = await ctx.waitFor(() => evaluateIn(device, readNotesPaneInPage, null, { label: 'read notes pane' }), { timeoutMs: 15_000, label: 'notes pane rendered' });
  noSecretIn('entry info notes outside blurred secrets', pane.visible);
  ctx.checkEqual(pane.blurred, [NOTE_SECRETS[0], NOTE_SECRETS[2]], 'entry info shows both kept secrets as blurred secret spans');
  await ctx.shot(device, 'mcp-notes-edited');

  // 10. The audit log has every call but none of the stored secret values the agent never wrote.
  const audit = fs.readFileSync(auditLogPath(device), 'utf8');
  const neverWritten = NOTE_SECRETS.slice(0, 2).filter((v) => audit.includes(v));
  ctx.checkEqual(neverWritten, [], 'audit log has no secret value that only the user typed');
  ctx.step('entry info page shows the notes with secrets hidden; audit log has no user-typed secret');
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
    { id: 'two-agents', title: 'Two MCP agents: each keeps its own shell, the other is refused but can read, freed when one exits', needsSupabase: false, run: twoAgents },
    { id: 'notes-secrets', title: 'Free user: partial notes edits and full rewrites keep hidden secrets; bad writes change nothing', run: notesSecrets },
    { id: 'audit', title: 'Every MCP call of the run is in the MCP audit log, secrets redacted', run: auditLog },
  ],
};
