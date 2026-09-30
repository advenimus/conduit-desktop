#!/usr/bin/env node
// One-off app run for the dashboard DATA package (docs/DASHBOARD.md 10.2): one local-mode device,
// a vault with an SSH entry on a closed local port and a web entry on the harness test page. Opens
// and closes the web entry, lets the SSH entry fail, then calls every dashboard channel through
// window.electron.invoke and saves the answers to .verify/dashboard/data/results.json with one
// screenshot. No Supabase, no live suite. Usage: node scripts/verify/capture-dashboard-data.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildForRun, startVite } from './lib/app.mjs';
import { scenarioContext } from './lib/context.mjs';
import { createRunContext, freePort, installSignalHandlers, VERIFY_DIR } from './lib/run-context.mjs';
import { startTestSite, vaultPath, withStores, VAULT_PASSWORD } from './lib/restyle-data.mjs';
import { launchInMode } from './lib/restyle-flows.mjs';
import { createVault, enterLocalMode, lockVault, refreshEntries, waitForScreen } from './lib/flows.mjs';
import { captureWindow } from './lib/window-capture.mjs';
import { invoke, invokeResult, sleep, waitFor } from './lib/ui.mjs';

const OUT_DIR = path.join(VERIFY_DIR, 'dashboard', 'data');

const log = (m) => console.log(`[dashboard-data] ${m}`);

function sessionOf(d, entryId) {
  return withStores(d, (id, s) => s.session.getState().sessions.find((x) => x.entryId === id) ?? null, entryId, { label: 'read session' });
}

/** Opens `entryId` like a double click and waits until its session reaches `status`. */
async function openUntil(d, entryId, status) {
  await withStores(d, (id, s) => {
    void s.entry.getState().openEntry(id).catch(() => {});
    return true;
  }, entryId, { label: `open ${entryId}` });
  return waitFor(async () => {
    const s = await sessionOf(d, entryId);
    return s && s.status === status ? s : null;
  }, { timeoutMs: 30_000, label: `session of ${entryId} ${status}` });
}

async function closeSession(d, sessionId) {
  await withStores(d, (id, s) => s.session.getState().closeSession(id), sessionId, { label: 'close session' });
}

/** Audit lines in the device's own HOME: this run's preview line, a production line and a legacy line. */
function writeAuditLog(d, entryId) {
  const file = path.join(d.root, 'home', '.config', 'conduit', 'audit.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { client: 'mcp-client', result: { type: 'success' }, duration_ms: 7 };
  const lines = [
    { ...base, timestamp: new Date(Date.now() - 60_000).toISOString(), tool: 'entry_info', parameters: { id: entryId }, env: 'preview' },
    { ...base, timestamp: new Date(Date.now() - 30_000).toISOString(), tool: 'terminal_execute', parameters: { session_id: 'prod-session' }, env: 'production' },
    { ...base, timestamp: new Date(Date.now() - 20_000).toISOString(), tool: 'entry_list', parameters: {} },
    { ...base, timestamp: new Date().toISOString(), tool: 'website_screenshot', parameters: { entry_id: 'web01.example.com' }, result: { type: 'error', message: 'host web01 down' }, env: 'preview' },
  ];
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

async function callAll(d, ids) {
  const call = (channel, args) => invokeResult(d, channel, args);
  return {
    connection_history_recent: await call('connection_history_recent', {}),
    connection_history_for_entry_web: await call('connection_history_for_entry', { entryId: ids.web }),
    connection_history_for_entry_ssh: await call('connection_history_for_entry', { entryId: ids.ssh }),
    password_age_list: await call('password_age_list', {}),
    ai_activity_recent: await call('ai_activity_recent', { limit: 5 }),
    reachability_web: await call('reachability_check', { entryId: ids.web }),
    reachability_ssh: await call('reachability_check', { entryId: ids.ssh }),
    reachability_credential: await call('reachability_check', { entryId: ids.cred }),
    reachability_unknown: await call('reachability_check', { entryId: 'no-such-entry' }),
    invalid_start: await call('connection_history_start', { entryId: '', protocol: 'telnet' }),
    invalid_limit: await call('connection_history_recent', { limit: 'lots' }),
  };
}

async function probeStartEnd(d, entryId) {
  const start = await invokeResult(d, 'connection_history_start', { entryId, protocol: 'command' });
  const end = start.ok && start.value ? await invokeResult(d, 'connection_history_end', { id: start.value.id, outcome: 'closed' }) : null;
  return { start, end };
}

function check(results, name, ok, detail) {
  results.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
}

function evaluate(results, ids, closedPort) {
  const u = results.unlocked;
  const recent = u.connection_history_recent.value ?? [];
  const webRow = recent.find((r) => r.entryId === ids.web);
  const sshRow = recent.find((r) => r.entryId === ids.ssh);
  check(results, 'web entry has a closed row', webRow?.lastOutcome === 'closed' && webRow.lastDurationMs !== null, webRow);
  check(results, 'ssh entry has a failed row', sshRow?.lastOutcome === 'failed', sshRow);
  check(results, 'reachable for the test site', u.reachability_web.value?.status === 'reachable', u.reachability_web);
  check(results, 'refused for the closed port', u.reachability_ssh.value?.status === 'refused' && u.reachability_ssh.value.port === closedPort, u.reachability_ssh);
  check(results, 'credential is not checkable', u.reachability_credential.value?.status === 'not_checkable');
  check(results, 'unknown entry rejects Entry not found', !u.reachability_unknown.ok && u.reachability_unknown.error.includes('Entry not found'));
  check(results, 'invalid arguments reject Invalid request', !u.invalid_start.ok && u.invalid_start.error.includes('Invalid request') && !u.invalid_limit.ok);
  const ages = u.password_age_list.value ?? [];
  check(results, 'changed password comes from history', ages.find((a) => a.entryId === ids.ssh)?.source === 'history', ages);
  check(results, 'unchanged credential password comes from creation', ages.find((a) => a.entryId === ids.cred)?.source === 'created');
  check(results, 'web entry without a password is not listed', !ages.some((a) => a.entryId === ids.web));
  const ai = u.ai_activity_recent.value;
  check(results, 'AI activity reads the device log with env filtering', ai?.logFound === true && ai.items.map((i) => i.tool).join(',') === 'website_screenshot,entry_info', ai);
  check(results, 'AI activity drops host-like ids and error text', ai?.items[0]?.entryId === null && !JSON.stringify(ai).includes('web01'));
  check(results, 'AI activity before the log existed says logFound false', results.aiBeforeLog.value?.logFound === false, results.aiBeforeLog);
  check(results, 'start and end work while unlocked', results.startEnd.start.value?.id && results.startEnd.end?.ok === true);
  const l = results.locked;
  check(results, 'locked: start gives null', l.start.ok && l.start.value === null);
  check(results, 'locked: recent, for-entry and ages give []', [l.recent, l.forEntry, l.ages].every((r) => r.ok && Array.isArray(r.value) && r.value.length === 0));
  check(results, 'locked: clear gives deleted 0', l.clear.ok && l.clear.value?.deleted === 0);
  check(results, 'locked: reachability rejects Vault is locked', !l.reach.ok && l.reach.error.includes('Vault is locked'));
  const c = results.clear;
  check(results, 'clear removes this vault\'s rows', c.clear.ok && c.clear.value?.deleted >= 3 && c.recentAfter.ok && c.recentAfter.value.length === 0, c);
  const db = results.historyFile;
  check(results, 'quit closes a row left open', db.openRows === 0 && db.rows.some((r) => r.entry_id === ids.cred && r.outcome === 'closed' && r.has_duration === 1), db);
  check(results, 'history file holds no host, entry name or password', db.leaks.length === 0, db.leaks);
}

async function lockedAnswers(d, ids) {
  return {
    start: await invokeResult(d, 'connection_history_start', { entryId: ids.web, protocol: 'web' }),
    recent: await invokeResult(d, 'connection_history_recent', {}),
    forEntry: await invokeResult(d, 'connection_history_for_entry', { entryId: ids.web }),
    clear: await invokeResult(d, 'connection_history_clear', {}),
    ages: await invokeResult(d, 'password_age_list', {}),
    reach: await invokeResult(d, 'reachability_check', { entryId: ids.web }),
  };
}

function inspectHistoryFile(d, secrets) {
  const file = path.join(d.root, 'appData', 'conduit', 'conduit-dev', 'connection-history.db');
  const query = (sql) => execFileSync('sqlite3', ['-json', file, sql], { encoding: 'utf8' }).trim();
  const rows = JSON.parse(query('SELECT entry_id, protocol, outcome, duration_ms IS NOT NULL AS has_duration FROM connection_history ORDER BY rowid') || '[]');
  const openRows = rows.filter((r) => r.outcome === 'open').length;
  const bytes = ['', '-wal'].map((s) => (fs.existsSync(file + s) ? fs.readFileSync(file + s, 'latin1') : '')).join('');
  return { file: path.relative(process.cwd(), file), rows, openRows, leaks: secrets.filter((s) => bytes.includes(s)) };
}

async function runDevice(ctx, siteUrl, closedPort) {
  const d = await launchInMode(ctx, 'dd', 'dark', { settings: { theme: 'dark' } });
  await enterLocalMode(d);
  await createVault(d, vaultPath(d, 'Dashboard Data'), VAULT_PASSWORD);
  await waitForScreen(d, 'main');
  const cred = await invoke(d, 'entry_create', { name: 'Ops Admin', entry_type: 'credential', username: 'ops', password: 'Cred-Pass-1', credential_type: 'password' });
  const ssh = await invoke(d, 'entry_create', { name: 'closed-port-ssh', entry_type: 'ssh', host: '127.0.0.1', port: closedPort, username: 'deploy', password: 'Old-Pass-1' });
  await invoke(d, 'entry_update', { id: ssh.id, password: 'New-Pass-2' });
  const web = await invoke(d, 'entry_create', { name: 'Intranet Status', entry_type: 'web', host: siteUrl });
  await refreshEntries(d);
  const ids = { cred: cred.id, ssh: ssh.id, web: web.id };
  log(`vault ready: ${JSON.stringify(ids)}`);

  const results = { closedPort, siteUrl, ids, checks: [] };
  results.aiBeforeLog = await invokeResult(d, 'ai_activity_recent', {});

  const webSession = await openUntil(d, ids.web, 'connected');
  await sleep(1_500);
  await closeSession(d, webSession.id);
  await waitFor(async () => (await sessionOf(d, ids.web)) === null, { timeoutMs: 15_000, label: 'web tab closed' });
  log('web entry opened and closed');
  const sshSession = await openUntil(d, ids.ssh, 'disconnected');
  results.sshSessionError = sshSession.error ? '(error text present, not recorded)' : null;
  log('ssh entry failed');
  await sleep(1_000);

  writeAuditLog(d, ids.ssh);
  results.unlocked = await callAll(d, ids);
  results.startEnd = await probeStartEnd(d, ids.cred);
  results.clear = {
    clear: await invokeResult(d, 'connection_history_clear', {}),
    recentAfter: await invokeResult(d, 'connection_history_recent', {}),
  };
  results.leftOpen = await invokeResult(d, 'connection_history_start', { entryId: ids.cred, protocol: 'command' });
  await captureWindow(d, path.join(OUT_DIR, 'app.png'), { method: 'page' });
  log('saved app.png');

  await lockVault(d);
  results.locked = await lockedAnswers(d, ids);
  log('locked answers read');
  results.quit = await ctx.quitDevice(d);
  results.historyFile = inspectHistoryFile(d, ['127.0.0.1', siteUrl, 'closed-port-ssh', 'Intranet Status', 'Old-Pass-1', 'New-Pass-2', 'deploy']);
  evaluate(results, ids, closedPort);
  return results;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const run = createRunContext();
  installSignalHandlers(run);
  let results = null;
  let failure = null;
  try {
    const mainJs = await buildForRun(run);
    const vite = await startVite(run, await freePort());
    const site = await startTestSite(run);
    const closedPort = await freePort();
    const { ctx, close } = scenarioContext({ run, env: { mainJs, devServerUrl: vite.url }, step: log });
    try {
      results = await runDevice(ctx, site.url, closedPort);
    } finally {
      await close();
    }
  } catch (err) {
    failure = err.message;
  } finally {
    await run.runCleanup();
  }
  const out = { capturedAt: new Date().toISOString(), failure, ...(results ?? {}) };
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), `${JSON.stringify(out, null, 2)}\n`);
  const failed = (results?.checks ?? []).filter((c) => !c.ok);
  for (const c of results?.checks ?? []) log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);
  if (failure) log(`run stopped: ${failure}`);
  log(`results in ${path.relative(process.cwd(), OUT_DIR)}/results.json`);
  return failure === null && failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[dashboard-data] ${err.message}`);
    process.exit(2);
  },
);
