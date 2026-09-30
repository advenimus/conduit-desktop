#!/usr/bin/env node
// Plan enforcement database tests (docs/PLAN_ENFORCEMENT.md 7.1) against the local Supabase stack:
// the repo migrations, then supabase/pending/*.sql, then the psql files in supabase/tests (team cases,
// then ownership, device cap, version and cloud cases, then the rollback check), the two-connection
// races (T4, O9) and the PostgREST cases (H1, H2).
// Usage: npm run test:sql

import fs from 'node:fs';
import path from 'node:path';
import { REPO, VERIFY_DIR } from './lib/run-context.mjs';
import { runCommand } from './lib/proc.mjs';
import { API_URL, DB_URL, ensureLocalSupabase, findPsql, getAnonKey, psql } from './lib/supabase-stack.mjs';
import { createTestUser, deleteTestUsers, passwordSession } from './lib/supabase.mjs';
import { runRaceCases } from './lib/sql-test-races.mjs';

const PENDING_DIR = path.join(REPO, 'supabase', 'pending');
const TESTS_DIR = path.join(REPO, 'supabase', 'tests');
const SQL_FILES = ['plan_enforcement_team.sql', 'plan_enforcement.sql', 'plan_enforcement_rollback.sql'];
const VERSIONED = /^\d{14}_.+\.sql$/;
const OK_NOTICE = /NOTICE:\s+ok (\S+)/g;
const SCHEMA_RELOAD_TRIES = 10;

const logDir = path.join(VERIFY_DIR, 'sql-tests', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(logDir, { recursive: true });
const log = Object.assign((msg) => console.log(`[sql] ${msg}`), { file: (name) => path.join(logDir, name) });

async function applyPending() {
  const files = fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR).filter((f) => VERSIONED.test(f)).sort() : [];
  for (const f of files) {
    await runCommand(await findPsql(), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', DB_URL, '-f', path.join(PENDING_DIR, f)], {
      timeoutMs: 120_000,
      logFile: log.file('pending.log'),
      label: `psql pending/${f}`,
    });
  }
  log(`applied ${files.length} pending migration(s): ${files.join(', ') || 'none'}`);
}

async function runSqlFile(name) {
  const res = await runCommand(await findPsql(), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB_URL, '-f', path.join(TESTS_DIR, name)], {
    timeoutMs: 300_000,
    logFile: log.file(`${name}.log`),
    label: `psql tests/${name}`,
    allowFailure: true,
  });
  const passed = [...res.stderr.matchAll(OK_NOTICE)].map((m) => m[1]);
  if (res.code !== 0) {
    const error = res.stderr.split('\n').filter((l) => /ERROR|CONTEXT/.test(l)).slice(0, 4).join('\n');
    return { passed, failed: [`${name}: ${error || `psql exit ${res.code}`}`] };
  }
  return { passed, failed: [] };
}

async function rpc(token, name, body) {
  const anon = await getAnonKey();
  const res = await fetch(`${API_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// PostgREST caches the function list; the migrations just dropped and recreated peek and acquire.
async function rpcAfterReload(token, name, body) {
  await psql("notify pgrst, 'reload schema'");
  let last = null;
  for (let i = 0; i < SCHEMA_RELOAD_TRIES; i++) {
    last = await rpc(token, name, body);
    if (last.json?.code !== 'PGRST202') return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return last;
}

async function runHttpCases() {
  const passed = [];
  const failed = [];
  const user = await createTestUser({ runId: `sqltest-${Date.now().toString(36)}` }, 'pro');
  const vaultKey = crypto.randomUUID();
  try {
    const { accessToken } = await passwordSession(user);
    const deviceId = crypto.randomUUID();

    const h1 = await rpcAfterReload(accessToken, 'vault_session_peek', { p_vault_key: vaultKey, p_device_id: deviceId });
    if (h1.status === 200 && Number.isInteger(h1.json?.device_cap)) passed.push('H1');
    else failed.push(`H1: HTTP ${h1.status} ${h1.text.slice(0, 300)}`);

    const h2 = await rpcAfterReload(accessToken, 'vault_session_acquire', {
      p_vault_key: vaultKey, p_device_id: deviceId, p_session_nonce: crypto.randomUUID(),
      p_device_name: 'sql-test', p_platform: 'macos', p_app_version: '0.18.0',
      p_file_name: 'v.conduit', p_file_id: null, p_location: null, p_takeover: false,
    });
    if (h2.status === 200 && h2.json?.granted === true && h2.json?.ownership === 'owner') passed.push('H2');
    else failed.push(`H2: HTTP ${h2.status} ${h2.text.slice(0, 300)}`);
  } finally {
    await psql("delete from public.personal_vault_owners where vault_key = :'key'", { vars: { key: vaultKey } });
    await deleteTestUsers();
  }
  return { passed, failed };
}

async function main() {
  await ensureLocalSupabase(log);
  await applyPending();

  const results = [];
  for (const name of SQL_FILES) results.push(await runSqlFile(name));
  results.push(await runRaceCases({ log }));
  results.push(await runHttpCases());

  const passed = results.flatMap((r) => r.passed);
  const failed = results.flatMap((r) => r.failed);
  console.log(`\n[sql] passed ${passed.length}: ${passed.join(' ')}`);
  if (failed.length > 0) {
    console.log(`[sql] FAILED ${failed.length}:\n  ${failed.join('\n  ')}`);
    console.log(`[sql] logs: ${logDir}`);
    process.exit(1);
  }
  console.log(`[sql] all passed (logs: ${logDir})`);
}

main().catch((err) => {
  console.error(`[sql] ${err.stack || err.message}`);
  process.exit(1);
});
