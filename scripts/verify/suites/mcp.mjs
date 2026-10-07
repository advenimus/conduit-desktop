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
  const docName = `MCP doc ${ctx.run.shortId}`;
  const docV1 = '# Draft\n\nfirst version';
  const docV2 = '# Runbook\n\nsecond version from MCP';

  const noted = await mcp.call('entry_update_notes', { entry_id: entry.id, notes: firstNotes });
  ctx.checkEqual([noted.id, noted.secrets_encrypted], [entry.id, 1], 'entry_update_notes answers for the entry and encrypted the !!secret!!');
  const info = await mcp.call('entry_info', { entry_id: entry.id, include_notes: true });
  const [secretRef] = secretRefsIn(info.notes);
  ctx.check(!!secretRef && info.notes.endsWith(`admin: ${secretRef.raw}`) && !info.notes.includes('mcp-verify-secret'), `entry_info shows the secret as a ref: ${info.notes}`);
  const edited = await mcp.call('entry_edit_notes', {
    entry_id: entry.id,
    edits: [{ old_string: 'Notes written by MCP', new_string: 'Notes edited by MCP' }],
  });
  ctx.checkEqual([edited.replacements, edited.secrets_removed], [1, 0], 'entry_edit_notes changed one line and kept the secret');
  const notes = `Notes edited by MCP in run ${ctx.runId}\nadmin: ${secretRef.raw}`;
  const doc = await mcp.call('document_create', { name: docName, content: docV1 });
  ctx.check(typeof doc?.id === 'string', `document_create returned an id: ${JSON.stringify(doc)}`);
  await mcp.call('document_update', { entry_id: doc.id, content: docV2 });
  const wroteAt = Date.now();
  ctx.step(`MCP on m3a: wrote and edited notes on ${entry.id}, created and updated document ${doc.id}`);

  const onA = await ui.invoke(a, 'entry_get', { id: entry.id });
  ctx.checkEqual(onA.notes, notes, 'm3a entry store (IPC entry_get) has the edited MCP notes with the secret ref intact');
  const secretOnA = await ui.invoke(a, 'entry_get_full', { id: secretRef.id });
  ctx.checkEqual([secretOnA.password, secretOnA.parent_entry_id, secretOnA.config?.embedded?.owner_id], ['mcp-verify-secret', entry.id, entry.id], 'm3a holds the value in an encrypted secret owned by the entry');
  const docOnA = await ui.invoke(a, 'entry_get', { id: doc.id });
  ctx.checkEqual([docOnA.name, docOnA.entry_type, docOnA.config?.content], [docName, 'document', docV2], 'm3a entry store has the MCP document');
  // Home no longer lists recent entries and test windows start with the side bar hidden, so the entry tree is the place to look.
  await setSidebar(a, 'docked');
  await ui.waitForText(a, docName, { timeoutMs: 15_000 });
  ctx.step('m3a renderer reloaded its entry list and shows the new document');

  await ctx.waitFor(async () => {
    const [e, d, sec] = await Promise.all([
      ui.invoke(b, 'entry_get', { id: entry.id }),
      ui.invoke(b, 'entry_get', { id: doc.id }),
      ui.invokeResult(b, 'entry_get_full', { id: secretRef.id }),
    ]);
    return e.notes === notes && d.name === docName && d.config?.content === docV2 && sec.ok && sec.value?.password === 'mcp-verify-secret';
  }, { timeoutMs: SYNC_DEADLINE_MS, intervalMs: 500, label: 'm3b receives the MCP notes, the encrypted secret and the document' });
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

// Secrets the agent must never see. They live encrypted in hidden credentials; notes, MCP output, errors and the audit log must not hold them.
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

/** The notes pane's text outside secret chips, and each chip's text (a chip shows the secret's name, never its value). */
export function readNotesPaneInPage() {
  const pane = [...document.querySelectorAll('.prose, [class*=prose]')].find((el) => /Summary/.test(el.textContent ?? ''));
  if (!pane) return null;
  const chips = [...pane.querySelectorAll('[data-cv-secret-chip]')].map((el) => (el.textContent ?? '').trim());
  const copy = pane.cloneNode(true);
  for (const el of copy.querySelectorAll('[data-cv-secret-chip]')) el.remove();
  return { visible: copy.textContent ?? '', chips, all: pane.textContent ?? '' };
}

export function openEntryDashboardInPage(id) {
  return import('/src/lib/openDashboard.ts').then((m) => {
    m.openDashboardForEntry(id);
    return true;
  });
}

const SECRET_REF_RE = /\{\{secret:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|([^}|\n]*))?\}\}/g;
const REVEAL_DIALOG_TITLE = 'Show a secret to an agent?';
// credential_read allows a burst of 2, then one call every 6 s (mcp/src/rate-limiter.ts).
const CREDENTIAL_READ_GAP_MS = 6_500;

function secretRefsIn(text) {
  return [...(text ?? '').matchAll(SECRET_REF_RE)].map((m) => ({ raw: m[0], id: m[1], label: m[2] ?? null }));
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
  const valueOf = async (id) => (await ui.invoke(device, 'entry_get_full', { id })).password;
  const noSecretIn = (label, text) => {
    const leaked = NOTE_SECRETS.filter((v) => text.includes(v));
    ctx.checkEqual(leaked, [], `${label} shows no secret value`);
  };

  // 1. Saving in the app encrypts each !!secret!! into a hidden credential and keeps only a ref.
  const v1 = await stored();
  noSecretIn('stored notes after the app save', v1);
  const [root, postgres] = secretRefsIn(v1);
  ctx.checkEqual([root?.label, postgres?.label], ['root', 'postgres'], 'both secrets became labelled refs');
  ctx.checkEqual(v1, NOTES_V1.replace(`!!${NOTE_SECRETS[0]}!!`, root.raw).replace(`!!${NOTE_SECRETS[1]}!!`, postgres.raw), 'the rest of the notes is unchanged');
  ctx.checkEqual([await valueOf(root.id), await valueOf(postgres.id)], NOTE_SECRETS.slice(0, 2), 'the encrypted secrets hold the typed values');
  const listed = await mcp.call('credential_list', {});
  ctx.check(!JSON.stringify(listed).includes(root.id), 'credential_list does not offer embedded secrets');
  ctx.step('m8: the app encrypted two !!secret!! values on save; the notes hold refs');

  // 2. Reads show the refs, never the values.
  const info = await mcp.callRaw('entry_info', { entry_id: entry.id, include_notes: true });
  noSecretIn('entry_info', info.text);
  ctx.checkEqual(info.data.notes, v1, 'entry_info shows the notes with refs');

  // 3. A one-line edit leaves the refs in place.
  let want = v1.replace('port: 22', 'port: 2222');
  const one = await mcp.call('entry_edit_notes', { entry_id: entry.id, edits: [{ old_string: 'port: 22', new_string: 'port: 2222' }] });
  ctx.checkEqual([one.replacements, one.secrets_removed, one.secrets_encrypted], [1, 0, 0], 'one-line edit: 1 replacement, nothing removed or added');
  ctx.checkEqual(await stored(), want, 'stored notes: port changed, both refs intact');

  // 4. Reword the line that holds a secret by keeping its ref.
  want = want.replace(`root: ${root.raw}`, `root (sudo only): ${root.raw}`);
  await mcp.call('entry_edit_notes', { entry_id: entry.id, edits: [{ old_string: `root: ${root.raw}`, new_string: `root (sudo only): ${root.raw}` }] });
  ctx.checkEqual(await stored(), want, 'stored notes: reworded secret line keeps its ref');

  // 5. Several edits in one call: move a section with its ref, replace_all, and add a new secret.
  const access = `root (sudo only): ${root.raw}\nport: 2222\n\n`;
  const multi = await mcp.call('entry_edit_notes', {
    entry_id: entry.id,
    edits: [
      { old_string: `## Access\n${access}## Database\npostgres: ${postgres.raw}\nversion: 15\n`, new_string: `## Database\npostgres: ${postgres.raw}\nversion: 16\n\n## Access\n${access.trimEnd()}\n` },
      { old_string: 'nginx', new_string: 'caddy', replace_all: true },
      { old_string: '- caddy upgraded', new_string: `- caddy upgraded\n- api key: !!${NOTE_SECRETS[2]}!!` },
    ],
  });
  ctx.checkEqual([multi.replacements, multi.secrets_removed, multi.secrets_encrypted], [4, 0, 1], 'multi-edit: 4 replacements, the new secret encrypted');
  const v5 = await stored();
  const api = secretRefsIn(v5).find((r) => r.label === 'api key');
  ctx.check(!!api && (await valueOf(api.id)) === NOTE_SECRETS[2], `the new secret is encrypted under its own ref: ${v5}`);
  want = [
    '## Database', `postgres: ${postgres.raw}`, 'version: 16', '',
    '## Access', `root (sudo only): ${root.raw}`, 'port: 2222', '',
    '## Log', '- caddy reloaded', '- caddy upgraded', `- api key: ${api.raw}`,
  ].join('\n');
  ctx.checkEqual(v5, want, 'stored notes: section moved with its ref, words replaced, new secret added as a ref');
  ctx.step('one call moved a section, replaced every "nginx" and added an encrypted secret');

  // 6. Refused writes change nothing and leak nothing.
  const refused = [
    ['old text not found', 'entry_edit_notes', { edits: [{ old_string: 'version: 99', new_string: 'x' }] }, /not found/],
    ['old text matches twice', 'entry_edit_notes', { edits: [{ old_string: 'caddy', new_string: 'x' }] }, /matches 2 places/],
    ['bare [REDACTED] marker', 'entry_edit_notes', { edits: [{ old_string: 'version: 16', new_string: 'version: [REDACTED]' }] }, /\[REDACTED\]/],
    ['token not in the notes', 'entry_edit_notes', { edits: [{ old_string: 'port: 2222', new_string: 'port: [SECRET_9]' }] }, /SECRET_9/],
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

  // 7. A full rewrite that drops a ref keeps the secret, flagged as unused.
  await mcp.call('entry_update_notes', { entry_id: entry.id, notes: `## Summary\nroot: ${root.raw}\napi: ${api.raw}` });
  ctx.checkEqual(await stored(), `## Summary\nroot: ${root.raw}\napi: ${api.raw}`, 'stored notes after full rewrite');
  const dropped = await ui.invoke(device, 'entry_get', { id: postgres.id });
  ctx.check(!!dropped.config?.embedded?.orphaned_at, 'the dropped secret is kept and flagged as unused');

  // 8. An entry with no notes takes an empty old_string.
  const blank = await flows.addEntry(device, { name: 'Notes blank target', host: '10.60.0.2' });
  await ui.sleep(NOTES_WRITE_GAP_MS);
  await mcp.call('entry_edit_notes', { entry_id: blank.id, edits: [{ old_string: '', new_string: '# Fresh notes' }] });
  ctx.checkEqual((await ui.invoke(device, 'entry_get', { id: blank.id })).notes, '# Fresh notes', 'empty notes filled through entry_edit_notes');

  // 9. Documents encrypt their secrets the same way.
  const doc = await mcp.call('document_create', { name: `Notes doc ${ctx.run.shortId}`, content: `API key: !!${NOTE_SECRETS[2]}!!` });
  ctx.checkEqual(doc.secrets_encrypted, 1, 'document_create encrypted the secret');
  const read = await mcp.callRaw('document_read', { entry_id: doc.id });
  noSecretIn('document_read', read.text);
  const [docRef] = secretRefsIn(read.data.content);
  ctx.checkEqual(read.data.content, `API key: ${docRef?.raw}`, 'document_read shows the ref');
  await mcp.call('document_update', { entry_id: doc.id, content: `${read.data.content}\nRotated: 2026-10` });
  ctx.checkEqual((await ui.invoke(device, 'entry_get', { id: doc.id })).config?.content, `API key: ${docRef.raw}\nRotated: 2026-10`, 'document_update kept the ref');
  ctx.step('blank notes filled; document secret encrypted and kept through read and update');

  // 10. An agent types a secret by ref; what it reads back shows the ref, not the value.
  const { session_id: shell } = await mcp.call('local_shell_create', {});
  const counted = await mcp.callRaw('terminal_execute', { connection_id: shell, command: `printf '%s' ${root.raw} | wc -c` });
  ctx.check(!counted.isError && new RegExp(`\\b${NOTE_SECRETS[0].length}\\b`).test(counted.text), `the shell got the real value (length ${NOTE_SECRETS[0].length}): ${counted.text.slice(-200)}`);
  const echoed = await mcp.callRaw('terminal_execute', { connection_id: shell, command: `echo ${root.raw}` });
  noSecretIn('terminal_execute output', echoed.text);
  ctx.check(echoed.text.includes(root.id), `the echoed value comes back as the ref: ${echoed.text.slice(-200)}`);
  const pane = await mcp.callRaw('terminal_read_pane', { connection_id: shell });
  noSecretIn('terminal_read_pane', pane.text);
  const js = await mcp.callRaw('website_execute_js', { connection_id: shell, code: `'${root.raw}'` });
  ctx.check(js.isError && /SECRET_REF_ERROR|page scripts/.test(js.text), `page scripts refuse refs: ${js.text.slice(0, 160)}`);
  ctx.step('typed a secret into a shell by ref; output and screen show only the ref');

  // 11. credential_read gives refs; a plain value needs the user's Allow in the reveal dialog.
  const cred = await mcp.call('credential_read', { credential_id: root.id });
  ctx.check(cred.password_ref?.includes(root.id) && !('password' in cred), `credential_read returns a ref and no value: ${JSON.stringify(cred)}`);
  const answer = async (button) => {
    const pending = mcp.callRaw('credential_read', { credential_id: root.id, reveal: true, purpose: `verify ${button}` });
    await ui.waitForText(device, REVEAL_DIALOG_TITLE, { timeoutMs: 15_000 });
    await ui.clickText(device, button, { exact: true });
    return pending;
  };
  const denied = await answer('Deny');
  ctx.check(denied.isError && /APPROVAL_DENIED/.test(denied.text), `Deny refuses the reveal: ${denied.text.slice(0, 160)}`);
  noSecretIn('denied reveal', denied.text);
  await ui.sleep(CREDENTIAL_READ_GAP_MS);
  const allowed = await answer('Allow once');
  ctx.checkEqual([allowed.isError, allowed.data?.password], [false, NOTE_SECRETS[0]], 'Allow once returns the plain value');
  ctx.step('credential_read returned a ref; the reveal dialog denied, then allowed, a plain value');

  // 12. The app shows the notes with chips naming the secrets.
  await flows.refreshEntries(device);
  await evaluateIn(device, openEntryDashboardInPage, entry.id, { label: 'open entry info' });
  await ui.waitForText(device, 'Summary', { timeoutMs: 15_000 });
  const shown = await ctx.waitFor(() => evaluateIn(device, readNotesPaneInPage, null, { label: 'read notes pane' }), { timeoutMs: 15_000, label: 'notes pane rendered' });
  noSecretIn('entry info notes', shown.all);
  ctx.checkEqual(shown.chips, ['root', 'api key'], 'entry info shows a chip for each secret, by name');
  await ctx.shot(device, 'mcp-notes-edited');

  // 13. The audit log has every call but none of the stored secret values the agent never wrote.
  const audit = fs.readFileSync(auditLogPath(device), 'utf8');
  const neverWritten = NOTE_SECRETS.slice(0, 2).filter((v) => audit.includes(v));
  ctx.checkEqual(neverWritten, [], 'audit log has no secret value that only the user typed');
  ctx.step('entry info page shows chips; audit log has no user-typed secret');
}

/** What the renderer's entry store holds: lists show `entries`; articles and secrets live in `hiddenEntries`. */
export function readEntryStoreInPage(ids) {
  return import('/src/stores/entryStore.ts').then(({ useEntryStore }) => {
    const { entries, hiddenEntries } = useEntryStore.getState();
    return { listed: ids.filter((id) => entries.some((e) => e.id === id)), hidden: ids.filter((id) => hiddenEntries.some((e) => e.id === id)) };
  });
}

const KB_NOTES = [
  'Ubuntu 24.04 web server for the client portal.',
  '## Restart steps',
  '1. systemctl restart nginx',
  '2. check https://portal/health',
  '## Known issues',
  'Disk fills from /var/log; logrotate runs nightly.',
].join('\n');

/** An agent learns from, writes to and verifies the knowledge base; the app keeps articles out of the entry tree. */
async function knowledgeBase(ctx) {
  const { flows, ui } = ctx;
  const user = await ctx.createUser('free');
  const [device] = await signedInDevices(ctx, user, ['m9']);
  await createSharedVault(ctx, device, 'McpKnowledge.conduit');
  const folder = await ui.invoke(device, 'folder_create', { name: 'Client Portal' });
  const entry = await flows.addEntry(device, { name: 'portal-web-01', host: '10.70.0.1', folder_id: folder.id, tags: ['ubuntu'], notes: KB_NOTES });
  const mcp = await trackedMcp(ctx, device);

  // 1. entry_info suggests moving notes that look like a knowledge base.
  const info = await mcp.call('entry_info', { entry_id: entry.id, include_notes: true });
  ctx.checkEqual([info.knowledge?.migration_suggested, info.knowledge?.articles], ['headings', []], 'entry_info suggests migrating the notes and lists no articles yet');

  // 2. The agent moves the notes into articles, keeping the notes.
  const imported = await mcp.call('kb_import_notes', {
    entry_id: entry.id,
    articles: [
      { title: 'Overview', kind: 'overview', content: 'Ubuntu 24.04 web server for the client portal.' },
      { title: 'Restart steps', kind: 'procedure', content: '1. systemctl restart nginx\n2. check https://portal/health' },
      { title: 'Disk fills from logs', kind: 'troubleshooting', content: 'Disk fills from /var/log; logrotate runs nightly.' },
    ],
  });
  ctx.checkEqual(imported.created.length, 3, 'kb_import_notes created three articles');
  ctx.checkEqual((await ui.invoke(device, 'entry_get', { id: entry.id })).notes, KB_NOTES, 'the notes were kept');

  // 3. Folder and vault knowledge reach the asset; the order follows the contract.
  await mcp.call('kb_write', { scope: 'folder', folder_id: folder.id, kind: 'facts', title: 'Portal network', content: 'VLAN 30, gateway 10.70.0.254' });
  await mcp.call('kb_write', { scope: 'vault', kind: 'playbook', title: 'Ubuntu patching', content: 'apt update && apt upgrade -y, then reboot in the window', tags: ['Ubuntu'] });
  const context = await mcp.call('kb_context', { entry_id: entry.id });
  ctx.checkEqual(context.articles.map((a) => [a.title, a.group]), [
    ['Overview', 'asset'], ['Restart steps', 'asset'], ['Disk fills from logs', 'asset'],
    ['Portal network', 'folder'], ['Ubuntu patching', 'vault'],
  ], 'kb_context lists asset, folder and vault knowledge in order');
  const after = await mcp.call('entry_info', { entry_id: entry.id });
  ctx.checkEqual([after.knowledge.migration_suggested, after.knowledge.articles.length], [null, 5], 'entry_info stops suggesting migration once articles exist');

  // 4. Partial edits, logging, verification and search.
  const steps = context.articles.find((a) => a.title === 'Restart steps');
  const edit = await mcp.call('kb_write', { article_id: steps.id, edits: [{ old_string: 'restart nginx', new_string: 'reload nginx' }], reason: 'reload keeps connections' });
  ctx.checkEqual(edit.replacements, 1, 'kb_write applied a partial edit');
  const read = await mcp.call('kb_read', { article_id: steps.id });
  ctx.check(read.content.includes('systemctl reload nginx') && read.unseen_agent_edit === true, `the article changed and is flagged for review: ${JSON.stringify(read).slice(0, 300)}`);
  ctx.checkEqual(read.history.map((h) => h.reason), ['Moved from notes', 'reload keeps connections'], 'the history has both revisions with reasons');
  await mcp.call('kb_log', { entry_id: entry.id, text: 'Switched restarts to reloads' });
  await mcp.call('kb_verify', { article_id: steps.id, still_true: true, note: 'ran it' });
  const found = await mcp.call('kb_search', { query: 'logrotate' });
  ctx.checkEqual(found.results[0]?.title, 'Disk fills from logs', 'kb_search finds the troubleshooting article');
  const withLog = await mcp.call('kb_context', { entry_id: entry.id });
  ctx.check(withLog.articles.some((a) => a.title === 'Change log' && a.kind === 'changelog'), 'kb_log created the change log');
  ctx.step('agent imported notes, added folder and vault knowledge, edited, logged, verified and searched');

  // 5. Articles stay out of entry lists; the app lists them only as knowledge.
  const listed = await mcp.call('entry_list', {});
  ctx.check(!listed.entries.some((e) => e.id === steps.id), 'entry_list leaves articles out');
  await flows.refreshEntries(device);
  const store = await evaluateIn(device, readEntryStoreInPage, [entry.id, steps.id], { label: 'read entry store' });
  ctx.checkEqual(store, { listed: [entry.id], hidden: [steps.id] }, 'the renderer lists the asset and keeps the article hidden');

  // 6. Deleting the asset deletes its articles too.
  await flows.deleteEntry(device, entry.id);
  const gone = await ui.invokeResult(device, 'entry_get', { id: steps.id });
  ctx.check(!gone.ok, 'the asset\'s articles were deleted with it');
  const folderLeft = await mcp.call('kb_context', { folder_id: folder.id });
  // A folder inherits only pinned vault articles; the tag-matched playbook applied to the asset, not the folder.
  ctx.checkEqual(folderLeft.articles.map((a) => a.title), ['Portal network'], 'the folder article remains');
  const playbook = await mcp.call('kb_search', { query: 'patching' });
  ctx.checkEqual(playbook.results.map((r) => r.title), ['Ubuntu patching'], 'the vault playbook remains');
  ctx.step('articles are hidden from entry lists and deleted with their asset');
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
    { id: 'knowledge', title: 'Free user: an agent imports notes, writes, logs, verifies and searches knowledge; articles stay out of lists', run: knowledgeBase },
    { id: 'audit', title: 'Every MCP call of the run is in the MCP audit log, secrets redacted', run: auditLog },
  ],
};
