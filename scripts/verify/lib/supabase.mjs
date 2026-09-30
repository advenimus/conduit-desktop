// Test users, SQL and lease rows on the local Supabase. Every user a run creates is deleted at cleanup.

import crypto from 'node:crypto';
import { API_URL, getAnonKey, getServiceKey, psql } from './supabase-stack.mjs';
import { sweepStaleTeams } from './team.mjs';

export { ensureLocalSupabase, getServiceKey, getAnonKey, API_URL, DB_URL, WORKDIR } from './supabase-stack.mjs';

const ROLES = new Set(['free', 'pro', 'team']);
const EMAIL_DOMAIN = 'conduit.local';
const STALE_USER_HOURS = 6;
const BACKUP_BUCKET = 'vaults';
const STORAGE_DELETE_BATCH = 100;

const created = [];
let counter = 0;

/** psql -At output. Use :'name' placeholders with `vars` for values. */
export function sql(query, vars = {}) {
  return psql(query, { vars });
}

/** Rows of `query` as parsed JSON objects. */
export async function sqlJson(query, vars = {}) {
  const out = await psql(`select coalesce(json_agg(t), '[]'::json) from (${query}) t`, { vars });
  return JSON.parse(out || '[]');
}

async function adminFetch(pathname, init = {}) {
  const key = await getServiceKey();
  const res = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Supabase admin ${init.method ?? 'GET'} ${pathname} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

/** Sets a user's plan (free / pro / team) the way billing would: user_profiles.tier_id. */
export async function setTier(userId, role) {
  if (!ROLES.has(role)) throw new Error(`Unknown role "${role}". Use free, pro or team`);
  const out = await psql(
    "update public.user_profiles set tier_id = (select id from public.tiers where name = :'tier') where id = :'uid' returning id",
    { vars: { tier: role, uid: userId } },
  );
  if (out !== userId) throw new Error(`No user_profiles row for ${userId}; the on_auth_user_created trigger did not run`);
}

/**
 * Creates a confirmed user with a random password on the given plan.
 * Returns {id, email, password, role}.
 */
export async function createTestUser(run, role = 'free') {
  if (!ROLES.has(role)) throw new Error(`Unknown role "${role}". Use free, pro or team`);
  counter += 1;
  const email = `verify-${run.runId}-${counter}@${EMAIL_DOMAIN}`.toLowerCase();
  const password = crypto.randomBytes(18).toString('base64url');
  const user = await adminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: `verify ${role} ${counter}` } }),
  });
  if (!user?.id) throw new Error(`Supabase did not return an id for ${email}`);
  created.push({ id: user.id, email });
  await setTier(user.id, role);
  return { id: user.id, email, password, role };
}

/** A password-grant session, the same tokens the website hands the app in its conduit:// link. */
export async function passwordSession(user) {
  const anon = await getAnonKey();
  const res = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token || !body.refresh_token) {
    throw new Error(`Password sign-in for ${user.email} failed: HTTP ${res.status} ${body.error_description ?? body.msg ?? ''}`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

// storage.objects has no link to auth.users, so a user's cloud backups outlive the user unless removed.
async function deleteUserObjects(id) {
  const rows = await sqlJson("select name from storage.objects where bucket_id = :'bucket' and name like :'prefix'", {
    bucket: BACKUP_BUCKET,
    prefix: `${id}/%`,
  });
  const names = rows.map((r) => r.name);
  for (let i = 0; i < names.length; i += STORAGE_DELETE_BATCH) {
    await adminFetch(`/storage/v1/object/${BACKUP_BUCKET}`, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: names.slice(i, i + STORAGE_DELETE_BATCH) }),
    });
  }
}

async function deleteUser(id) {
  const objectsError = await deleteUserObjects(id).then(() => null, (err) => err);
  try {
    await adminFetch(`/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch {
    await psql("delete from auth.users where id = :'uid'", { vars: { uid: id } });
  }
  if (objectsError) throw new Error(`cloud backup objects of ${id} were not removed: ${objectsError.message}`);
}

/** Deletes every user this process created and their cloud backups. Lease rows go with them (on delete cascade). */
export async function deleteTestUsers() {
  const failures = [];
  while (created.length > 0) {
    const { id, email } = created.pop();
    try {
      await deleteUser(id);
    } catch (err) {
      failures.push(`${email}: ${err.message}`);
    }
  }
  if (failures.length > 0) throw new Error(`Could not delete test users:\n  ${failures.join('\n  ')}`);
}

/** Removes verify users (and teams they own) left behind by runs that died more than a few hours ago. */
export async function sweepStaleTestUsers() {
  await sweepStaleTeams();
  const rows = await sqlJson(
    `select id, email from auth.users where email like 'verify-%@${EMAIL_DOMAIN}' and created_at < now() - interval '${STALE_USER_HOURS} hours'`,
  );
  for (const row of rows) await deleteUser(row.id);
  return rows.length;
}

/** personal_vault_sessions rows (device leases) of a user, oldest first. */
export function leaseRows(email) {
  return sqlJson(
    `select s.vault_key, s.device_id, s.device_name, s.status, s.displaced_reason, s.displaced_by_device,
            s.file_name, s.pending_changes, s.acquired_at, s.heartbeat_at, s.expires_at
       from public.personal_vault_sessions s join auth.users u on u.id = s.user_id
      where u.email = :'email' order by s.acquired_at`,
    { email },
  );
}
