import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { AppwriteException, Client, Query, Storage, TablesDB, Users } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { coerce, rowIdFor } from '../src/api/codec.ts';
import { realtimePermissions } from '../src/api/engine.ts';
import type { Row } from '../src/api/filters.ts';
import { ConflictError } from '../src/api/errors.ts';
import { AppwriteStore, type Write } from '../src/api/store.ts';
import { syncVaultTeam } from '../src/runtime/services.ts';
import { DATABASE_ID, tableSpec } from '../src/schema/tables.ts';

// Copies a Supabase project into an Appwrite project: accounts (same UUIDs, bcrypt hashes, email
// verification, MFA bridge), every live table as-is (no triggers re-run), storage files, and the
// vault teams that drive Realtime. Safe to run again: rows and files are upserted by key.
//
// Env: SUPABASE_DB_URL (postgres://...), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_JWT_SECRET,
//      APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY. SUPABASE_DB_ROLE (optional, e.g. postgres)
//      is switched to after connecting, for the CLI's temporary login role.
// Flags: --dry-run (read and count only), --skip-files, --archive-dir <dir> (legacy tables as JSON),
//        --recreate-changed (re-create accounts whose password changed since an earlier run; the final
//        cutover run should go into an empty project instead).

const { values: flags } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'skip-files': { type: 'boolean', default: false },
    'archive-dir': { type: 'string' },
    'recreate-changed': { type: 'boolean', default: false },
  },
});

const env = process.env;
for (const k of ['SUPABASE_DB_URL', 'APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY']) {
  if (!env[k]) throw new Error(`${k} is required`);
}
const log = (m: string) => console.log(`[import] ${m}`);
const dry = flags['dry-run'];

/** Live tables in an order that satisfies foreign keys. vault_locks are short-lived and not copied. */
export const IMPORT_TABLES = [
  'tiers', 'app_config', 'user_profiles', 'teams', 'team_members', 'team_invitations', 'team_vaults',
  'team_vault_members', 'vault_key_wraps', 'vault_folders', 'vault_entries', 'vault_folder_permissions',
  'vault_password_history', 'vault_audit_log', 'user_public_keys', 'user_key_backups', 'device_auth_requests',
  'feedback_submissions', 'personal_vault_owners', 'personal_vault_guest_grace', 'personal_vault_sessions',
  'device_fingerprints', 'abuse_flags',
] as const;

/** Read by nothing in the new stack; kept as a JSON archive. */
export const LEGACY_TABLES = ['ai_models', 'user_token_budgets', 'token_usage_log', 'user_chat_conversations', 'user_chat_storage', 'user_entry_counts'] as const;

const client = new Client().setEndpoint(env.APPWRITE_ENDPOINT!).setProject(env.APPWRITE_PROJECT_ID!).setKey(env.APPWRITE_API_KEY!);
const users = new Users(client);
const tables = new TablesDB(client);
const store = new AppwriteStore(tables);
const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL });

function toAppwriteRow(table: string, raw: Record<string, unknown>): Row {
  const spec = tableSpec(table);
  const out: Row = {};
  for (const name of Object.keys(spec.columns)) {
    let v = raw[name];
    if (v instanceof Date) v = v.toISOString();
    if (spec.columns[name]!.type === 'float' && typeof v === 'string') v = Number(v);
    if ((spec.columns[name]!.type === 'bigint' || spec.columns[name]!.type === 'int') && typeof v === 'string') v = Number(v);
    out[name] = coerce(spec, name, v ?? null);
  }
  return out;
}

async function waitForCascade(userId: string): Promise<void> {
  const profiles = tableSpec('user_profiles');
  for (let i = 0; i < 120; i++) {
    if (!(await store.get(profiles, userId))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  // The users.*.delete event clears several tables; give it a moment past the profile row.
  await new Promise((r) => setTimeout(r, 3000));
}

async function copyUsers(): Promise<{ total: number; created: number; recreated: number; stale: number; mfaBridge: number }> {
  const { rows } = await db.query(`
    select u.id, u.email, u.encrypted_password, u.email_confirmed_at, u.raw_user_meta_data, u.banned_until,
           exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.factor_type = 'totp' and f.status = 'verified') as has_totp
      from auth.users u where u.deleted_at is null order by u.created_at`);
  let created = 0;
  let recreated = 0;
  let stale = 0;
  let mfaBridge = 0;
  for (const u of rows) {
    const hash = String(u.encrypted_password ?? '');
    if (!/^\$2[aby]\$/.test(hash)) throw new Error(`user ${u.id} has no bcrypt hash`);
    const name = (u.raw_user_meta_data?.display_name as string | undefined) || String(u.email).split('@')[0];
    if (dry) continue;
    let existing = null;
    try {
      existing = await users.get({ userId: u.id });
    } catch (e) {
      if (!(e instanceof AppwriteException && e.code === 404)) throw e;
    }
    if (existing && (existing as unknown as { password?: string }).password !== hash) {
      if (!flags['recreate-changed']) {
        stale++;
        log(`  ${u.id}: password changed since the last run (use --recreate-changed)`);
      } else {
        // Deleting runs the users.*.delete cascade; wait for it so it cannot hit the rows copied next.
        await users.delete({ userId: u.id });
        await waitForCascade(u.id);
        existing = null;
        recreated++;
      }
    }
    if (!existing) {
      await users.createBcryptUser({ userId: u.id, email: String(u.email).toLowerCase(), password: hash, name });
      created++;
    }
    await users.updateEmailVerification({ userId: u.id, emailVerification: u.email_confirmed_at !== null });
    // Authenticator secrets cannot be moved: those users get the email code as their second step until
    // they add a new authenticator.
    await users.updateMFA({ userId: u.id, mfa: u.has_totp === true });
    if (u.has_totp) mfaBridge++;
    const banned = u.banned_until !== null && new Date(u.banned_until).getTime() > Date.now();
    await users.updateStatus({ userId: u.id, status: !banned });
  }
  return { total: rows.length, created, recreated, stale, mfaBridge };
}

async function commitWithRetry(writes: Write[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await store.commit(writes, new Map());
    } catch (e) {
      if (!(e instanceof ConflictError) || attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/** New accounts get a Free profile from the users.*.create event; let those land before profiles are copied. */
async function waitForSignupEvents(): Promise<void> {
  const { rows } = await db.query('select id from auth.users where deleted_at is null');
  const profiles = tableSpec('user_profiles');
  const until = Date.now() + 120_000;
  for (const { id } of rows) {
    while (!(await store.get(profiles, id))) {
      if (Date.now() > until) throw new Error(`no profile for ${id} from the users.*.create event after 2 minutes; is the api function deployed?`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** IDs of these rows that already exist. Upsert inside a transaction reports a conflict on tables with a unique index, so the copy picks create or update itself. */
async function existingIds(table: string, ids: string[]): Promise<Set<string>> {
  const found = await tables.listRows({ databaseId: DATABASE_ID, tableId: table, queries: [Query.equal('$id', ids), Query.select(['$id']), Query.limit(ids.length)], total: false });
  return new Set(found.rows.map((r) => r.$id));
}

/**
 * A fresh project is seeded with the prod tier IDs. A source with other tier IDs (a dev stack) would
 * clash on the unique tier name, so a same-named tier with another ID is replaced. Profiles are
 * copied after this and point at the source IDs.
 */
async function replaceSeededTiers(): Promise<void> {
  const spec = tableSpec('tiers');
  const { rows } = await db.query('select id, name from public.tiers');
  for (const t of rows) {
    const found = await tables.listRows({ databaseId: DATABASE_ID, tableId: 'tiers', queries: [Query.equal('name', [t.name])], total: false });
    for (const r of found.rows.filter((r) => r.$id !== t.id)) {
      await store.commit([{ kind: 'delete', spec, rowId: r.$id, row: null }], new Map());
      log(`  replaced seeded tier ${t.name} (${r.$id} -> ${t.id})`);
    }
  }
}

async function copyTable(table: string): Promise<number> {
  const spec = tableSpec(table);
  const { rows } = await db.query(`select * from public.${table}`);
  if (dry) return rows.length;
  if (table === 'tiers') await replaceSeededTiers();
  for (let i = 0; i < rows.length; i += 90) {
    const batch = rows.slice(i, i + 90).map((raw) => toAppwriteRow(table, raw));
    const have = await existingIds(table, batch.map((row) => rowIdFor(spec, row)));
    const writes: Write[] = batch.map((row) => {
      const rowId = rowIdFor(spec, row);
      const permissions = realtimePermissions(spec, row);
      return { kind: have.has(rowId) ? 'update' : 'create', spec, rowId, row, ...(permissions ? { permissions } : {}) };
    });
    try {
      await commitWithRetry(writes);
    } catch (e) {
      throw new Error(`${table} rows ${i}-${i + writes.length - 1}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return rows.length;
}

function serviceKey(): string {
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_JWT_SECRET) throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_JWT_SECRET is required for files');
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', iss: 'import', exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${head}.${createHmac('sha256', env.SUPABASE_JWT_SECRET).update(head).digest('base64url')}`;
}

async function copyFiles(): Promise<{ files: number; bytes: number; skipped: number }> {
  const { rows } = await db.query(`
    select bucket_id, name, owner_id, coalesce((metadata->>'size')::bigint, 0) as size, metadata->>'mimetype' as mime, created_at, updated_at
      from storage.objects where bucket_id in ('vaults', 'feedback-logs') order by bucket_id, name`);
  const spec = tableSpec('cloud_files');
  const storage = new Storage(client);
  const key = dry ? '' : serviceKey();
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  for (const o of rows) {
    const owner = String(o.owner_id ?? o.name.split('/')[0]);
    if (!/^[0-9a-f-]{36}$/.test(owner)) {
      skipped++;
      log(`  skip ${o.bucket_id}/${o.name}: no owning account`);
      continue;
    }
    files++;
    bytes += Number(o.size);
    if (dry) continue;
    const existing = await store.get(spec, rowIdFor(spec, { bucket: o.bucket_id, path: o.name }));
    if (existing && Number(existing.size) === Number(o.size) && existing.updated_at === new Date(o.updated_at).toISOString()) continue;
    const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${o.bucket_id}/${o.name.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`download ${o.bucket_id}/${o.name}: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const fileId = randomUUID().replace(/-/g, '');
    await storage.createFile({ bucketId: o.bucket_id, fileId, file: InputFile.fromBuffer(body, o.name.split('/').pop() || 'file') });
    const row = toAppwriteRow('cloud_files', {
      bucket: o.bucket_id, path: o.name, owner_id: owner, file_id: fileId, size: body.length, mime_type: o.mime ?? 'application/octet-stream',
      created_at: o.created_at, updated_at: o.updated_at,
    });
    await commitWithRetry([{ kind: existing ? 'update' : 'create', spec, rowId: rowIdFor(spec, row), row }]);
    if (existing) await storage.deleteFile({ bucketId: o.bucket_id, fileId: existing.file_id as string }).catch(() => undefined);
  }
  return { files, bytes, skipped };
}

async function syncVaultTeams(): Promise<number> {
  const { rows } = await db.query('select team_vault_id, user_id, role from public.team_vault_members');
  if (!dry) for (const m of rows) await syncVaultTeam(client, m.team_vault_id, m.user_id, m.role);
  return rows.length;
}

async function appwriteCount(table: string): Promise<number> {
  const r = await tables.listRows({ databaseId: DATABASE_ID, tableId: table, queries: [Query.limit(1)] });
  return r.total;
}

async function verify(): Promise<string[]> {
  const problems: string[] = [];
  for (const table of IMPORT_TABLES) {
    const { rows } = await db.query(`select count(*)::int as n from public.${table}`);
    const have = await appwriteCount(table);
    if (have < rows[0].n) problems.push(`${table}: Supabase ${rows[0].n}, Appwrite ${have}`);
  }
  const { rows: u } = await db.query('select count(*)::int as n from auth.users where deleted_at is null');
  const appUsers = (await users.list({ queries: [Query.limit(1)] })).total;
  if (appUsers < u[0].n) problems.push(`users: Supabase ${u[0].n}, Appwrite ${appUsers}`);
  return problems;
}

async function archiveLegacy(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const table of LEGACY_TABLES) {
    const { rows } = await db.query(`select * from public.${table}`).catch(() => ({ rows: [] as unknown[] }));
    writeFileSync(join(dir, `${table}.json`), JSON.stringify(rows, null, 1));
    log(`  archived ${table}: ${rows.length} rows`);
  }
}

if (process.argv[1]?.endsWith('import-supabase.ts')) {
  await db.connect();
  if (env.SUPABASE_DB_ROLE) await db.query(`set role ${db.escapeIdentifier(env.SUPABASE_DB_ROLE)}`);
  try {
    log(dry ? 'dry run: reading only' : `importing into ${env.APPWRITE_ENDPOINT} (${env.APPWRITE_PROJECT_ID})`);
    const u = await copyUsers();
    log(`users: ${u.total} (created ${u.created}, re-created ${u.recreated}, password changed and left as is ${u.stale}, email-code MFA bridge ${u.mfaBridge})`);
    if (!dry) await waitForSignupEvents();
    for (const table of IMPORT_TABLES) log(`${table}: ${await copyTable(table)} rows`);
    log(`vault team memberships: ${await syncVaultTeams()}`);
    if (!flags['skip-files']) {
      const f = await copyFiles();
      log(`files: ${f.files} (${(f.bytes / 1_048_576).toFixed(1)} MB), skipped ${f.skipped}`);
    }
    if (flags['archive-dir']) await archiveLegacy(flags['archive-dir']);
    if (!dry) {
      const problems = await verify();
      if (problems.length) {
        log(`VERIFY FAILED:\n  ${problems.join('\n  ')}`);
        process.exitCode = 1;
      } else {
        log('verify: every table and the user count match or exceed Supabase');
      }
    }
  } finally {
    await db.end();
  }
}
