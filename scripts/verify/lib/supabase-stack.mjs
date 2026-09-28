// Local Supabase for verify runs: start it if needed, seed it from a preview backup, and apply the
// repo's sync migrations on every run. Never talks to anything but 127.0.0.1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO } from './run-context.mjs';
import { runCommand } from './proc.mjs';
import { PARITY_SUMMARY, applyLocalParity, parityProblems } from './supabase-parity.mjs';

export const API_URL = 'http://127.0.0.1:54321';
export const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const WORKDIR = path.join(os.homedir(), '.cache', 'conduit-verify', 'supabase');

const CLI_VERSION = '2.109.1';
const BACKUP_DIR = path.join(os.homedir(), 'conduit-backups');
const BACKUP_PATTERN = /^conduit-preview-.*\.sql$/;
const MIGRATIONS_DIR = path.join(REPO, 'supabase', 'migrations');
const BASE_MIGRATION = '20260501000000_add_parent_entry_id.sql';
// Every migration from the multi-device sync work onward (they are all idempotent).
const FIRST_SYNC_VERSION = '20260926000000';
const VERSIONED_MIGRATION = /^(\d{14})_.+\.sql$/;
const SESSION_RPCS = ['vault_session_peek', 'vault_session_acquire', 'vault_session_heartbeat', 'vault_session_release', 'vault_session_abandon'];
const EXPECTED_TIERS = { free: '1', pro: '-1', team: '-1' };
const PSQL_CANDIDATES = ['/opt/homebrew/opt/libpq/bin/psql', '/usr/local/opt/libpq/bin/psql', '/usr/bin/psql'];

let cachedPsql = null;
let cachedStatus = null;

export function supabaseCli() {
  const custom = process.env.SUPABASE_CLI?.trim();
  return custom ? { cmd: custom, pre: [] } : { cmd: 'npx', pre: ['-y', `supabase@${CLI_VERSION}`] };
}

export async function findPsql() {
  if (cachedPsql) return cachedPsql;
  const candidates = [process.env.PSQL, ...PSQL_CANDIDATES].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return (cachedPsql = found);
  const which = await runCommand('which', ['psql'], { allowFailure: true, label: 'which psql' });
  if (which.code === 0 && which.stdout.trim()) return (cachedPsql = which.stdout.trim());
  throw new Error('psql not found. Install libpq (brew install libpq) or set PSQL=/path/to/psql');
}

/** Runs SQL through psql. `vars` become psql variables (use :'name' in the query). */
export async function psql(query, { vars = {}, logFile, timeoutMs = 60_000, tuplesOnly = true } = {}) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  if (tuplesOnly) args.push('-At');
  for (const [name, value] of Object.entries(vars)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Bad psql variable name: ${name}`);
    args.push('-v', `${name}=${value}`);
  }
  args.push('-d', DB_URL, '-f', '-');
  const { stdout } = await runCommand(await findPsql(), args, { input: query, logFile, timeoutMs, label: 'psql' });
  return stdout.trim();
}

function prepareWorkdir() {
  const target = path.join(WORKDIR, 'supabase');
  fs.mkdirSync(path.join(target, 'migrations'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'supabase', 'config.toml'), path.join(target, 'config.toml'));
  fs.cpSync(path.join(REPO, 'supabase', 'templates'), path.join(target, 'templates'), { recursive: true });
  // The repo's migrations cannot bootstrap an empty database; the schema comes from a backup instead.
  for (const f of fs.readdirSync(path.join(target, 'migrations'))) {
    fs.rmSync(path.join(target, 'migrations', f), { recursive: true, force: true });
  }
}

async function apiHealthy() {
  try {
    const res = await fetch(`${API_URL}/auth/v1/health`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function dbReachable() {
  try {
    return (await psql('select 1', { timeoutMs: 10_000 })) === '1';
  } catch {
    return false;
  }
}

async function startStack(log) {
  const { cmd, pre } = supabaseCli();
  log(`starting local Supabase (${cmd} ${pre.join(' ')} start), this can take a few minutes`);
  await runCommand(cmd, [...pre, 'start', '--workdir', WORKDIR], {
    cwd: WORKDIR,
    timeoutMs: 15 * 60_000,
    logFile: log.file('supabase-start.log'),
    label: 'supabase start',
  });
  for (let i = 0; i < 60; i++) {
    if ((await apiHealthy()) && (await dbReachable())) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('Local Supabase started but the API or database did not become reachable within 60 s');
}

function newestBackup() {
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_PATTERN.test(f)) : [];
  if (files.length === 0) {
    throw new Error(`public.tiers is missing and no ${BACKUP_DIR}/conduit-preview-*.sql backup exists to seed the database. ` +
      'Copy a preview backup there (see docs/LOCAL_SUPABASE.md), then rerun.');
  }
  return files
    .map((f) => ({ file: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].file;
}

async function tiersTableExists() {
  return (await psql("select to_regclass('public.tiers') is not null")) === 't';
}

async function restoreBackup(log) {
  const file = newestBackup();
  log(`seeding the database from ${path.basename(file)} (auth schema errors are expected)`);
  const restoreLog = log.file('supabase-restore.log');
  await runCommand(await findPsql(), ['-X', '-q', '-v', 'ON_ERROR_STOP=0', '-d', DB_URL, '-f', file], {
    timeoutMs: 10 * 60_000,
    logFile: restoreLog,
    allowFailure: true,
    label: 'psql restore',
  });
  if (!(await tiersTableExists())) {
    throw new Error(`Restoring ${file} did not create public.tiers. See ${restoreLog}`);
  }
}

export function migrationFiles() {
  const names = fs.readdirSync(MIGRATIONS_DIR);
  const sync = names.filter((n) => (VERSIONED_MIGRATION.exec(n)?.[1] ?? '') >= FIRST_SYNC_VERSION).sort();
  if (!names.includes(BASE_MIGRATION)) throw new Error(`Missing supabase/migrations/${BASE_MIGRATION}`);
  if (sync.length === 0) throw new Error(`No supabase/migrations/<version>_*.sql files at or after ${FIRST_SYNC_VERSION}`);
  return [BASE_MIGRATION, ...sync].map((n) => path.join(MIGRATIONS_DIR, n));
}

// The preview backup carries no GRANTs, and current Supabase images no longer give anon and
// authenticated table privileges by default. Production has the classic defaults (RLS does the
// filtering), so restore those before the migrations re-apply their own narrower revokes.
const API_GRANTS = `
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;
`;

async function applyApiGrants(log) {
  await psql(API_GRANTS, { logFile: log.file('supabase-migrate.log') });
}

async function applyMigrations(log) {
  const logFile = log.file('supabase-migrate.log');
  const files = migrationFiles();
  for (const file of files) {
    await runCommand(await findPsql(), ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-d', DB_URL, '-f', file], {
      timeoutMs: 120_000,
      logFile,
      label: `psql ${path.basename(file)}`,
    });
  }
  log(`applied ${files.length} migrations: ${files.map((f) => path.basename(f).split('_')[0]).join(', ')}`);
}

async function verifySchema() {
  const tierRows = await psql(
    "select name || '|' || coalesce(features->>'vault_max_open_devices', 'null') || '|' || coalesce(features->>'mcp_daily_quota', 'null') " +
      "from public.tiers where name in ('free', 'pro', 'team') order by name",
  );
  const tiers = Object.fromEntries(tierRows.split('\n').filter(Boolean).map((l) => {
    const [name, devices, quota] = l.split('|');
    return [name, { devices, quota }];
  }));
  const problems = [];
  for (const [name, devices] of Object.entries(EXPECTED_TIERS)) {
    if (!tiers[name]) problems.push(`tier ${name} is missing`);
    else {
      if (tiers[name].devices !== devices) problems.push(`tier ${name} vault_max_open_devices=${tiers[name].devices}, expected ${devices}`);
      if (tiers[name].quota !== '-1') problems.push(`tier ${name} mcp_daily_quota=${tiers[name].quota}, expected -1`);
    }
  }
  const fns = (await psql(
    "select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname like 'vault_session_%'",
  )).split('\n');
  for (const fn of SESSION_RPCS) if (!fns.includes(fn)) problems.push(`function public.${fn} is missing`);
  const sessionsFor = await psql(
    "select position('''heartbeat_at''' in prosrc) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = 'vault_sessions_for'",
  );
  if (sessionsFor !== 't') problems.push('public.vault_sessions_for does not return heartbeat_at (20260927234038)');
  problems.push(...(await parityProblems((q) => psql(q))));
  if (problems.length > 0) throw new Error(`Local Supabase schema check failed:\n  - ${problems.join('\n  - ')}`);
}

/** `supabase status -o env` values (keys included). Cached; never logged. */
export async function stackStatus() {
  if (cachedStatus) return cachedStatus;
  const { cmd, pre } = supabaseCli();
  const { stdout } = await runCommand(cmd, [...pre, 'status', '--workdir', WORKDIR, '-o', 'env'], {
    cwd: WORKDIR,
    timeoutMs: 120_000,
    label: 'supabase status',
  });
  const values = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m) values[m[1]] = m[2];
  }
  if (!values.SERVICE_ROLE_KEY || !values.ANON_KEY) {
    throw new Error('supabase status did not report SERVICE_ROLE_KEY and ANON_KEY. Is the local stack running?');
  }
  cachedStatus = values;
  return values;
}

export async function getServiceKey() {
  return (await stackStatus()).SERVICE_ROLE_KEY;
}

export async function getAnonKey() {
  return (await stackStatus()).ANON_KEY;
}

/**
 * Makes sure the local stack is up, seeded and on the repo's current sync migrations. Works when the
 * stack was started from another workdir: containers are found by project_id ("conduit").
 * `log(msg)` reports progress; `log.file(name)` names a log file in the run's logs dir.
 */
export async function ensureLocalSupabase(log) {
  prepareWorkdir();
  if (!(await apiHealthy()) || !(await dbReachable())) {
    await startStack(log);
  } else {
    log('local Supabase already running');
  }
  if (!(await tiersTableExists())) await restoreBackup(log);
  await applyApiGrants(log);
  await applyMigrations(log);
  await applyLocalParity({ psqlPath: await findPsql(), dbUrl: DB_URL, logFile: log.file('supabase-migrate.log') });
  log(`applied local-parity.sql (${PARITY_SUMMARY})`);
  await verifySchema();
  await stackStatus();
  log(`schema ok: tiers free=1 pro=-1 team=-1, mcp_daily_quota=-1, vault_session_* present, vault_sessions_for returns heartbeat_at, ${PARITY_SUMMARY}`);
}
