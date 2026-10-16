// Test users, table rows and lease rows on the local Appwrite. Every user a run creates is deleted
// at cleanup. Table access goes through the api function as the trusted service (row rules off,
// triggers on), the same path the website uses.

import crypto from 'node:crypto';
import { Account, Client, Query, Users } from 'node-appwrite';
import { ConduitDb } from '../../../appwrite/src/client/index.ts';
import { directFiles, functionTransport } from '../../../appwrite/src/client/appwrite-transport.ts';
import { stackEnv } from './appwrite-stack.mjs';
import { sweepStaleTeams } from './team.mjs';

export { ensureLocalAppwrite, stackEnv } from './appwrite-stack.mjs';

const ROLES = new Set(['free', 'pro', 'team']);
const EMAIL_DOMAIN = 'conduit.local';
const STALE_USER_HOURS = 6;
const BACKUP_BUCKET = 'vaults';

const created = [];
let counter = 0;
let serviceDb = null;

export function adminClient() {
  const env = stackEnv();
  return new Client().setEndpoint(env.APPWRITE_ENDPOINT).setProject(env.APPWRITE_PROJECT_ID).setKey(env.APPWRITE_API_KEY);
}

/** The api function as the trusted service. */
export function db() {
  if (!serviceDb) serviceDb = new ConduitDb(functionTransport(adminClient(), { serviceSecret: stackEnv().CONDUIT_SERVICE_SECRET }));
  return serviceDb;
}

function must(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.code} ${res.error.message}`);
  return res.data;
}

/** Rows of `table` whose columns equal `eq` ({column: value}), as the service. */
export async function rows(table, eq = {}, { columns = '*', order } = {}) {
  let q = db().from(table).select(columns).match(eq);
  if (order) q = q.order(order.column, { ascending: order.ascending !== false });
  return must(await q, `select ${table}`) ?? [];
}

export async function updateRows(table, values, eq) {
  return must(await db().from(table).update(values).match(eq).select(), `update ${table}`);
}

export async function insertRows(table, values) {
  return must(await db().from(table).insert(values).select(), `insert ${table}`);
}

/** Moves timestamp `column` of the matching rows `seconds` into the past (the old "col - interval"). */
export async function shiftBack(table, column, eq, seconds) {
  for (const row of await rows(table, eq)) {
    if (!row[column]) continue;
    const key = Object.fromEntries(Object.entries(eq));
    for (const pk of ['id', 'vault_key', 'user_id', 'device_id', 'account_lo', 'account_hi']) if (pk in row && !(pk in key)) key[pk] = row[pk];
    await updateRows(table, { [column]: new Date(Date.parse(row[column]) - seconds * 1000).toISOString() }, key);
  }
}

/** Sets a user's plan (free / pro / team) the way billing would: user_profiles.tier_id. */
export async function setTier(userId, role) {
  if (!ROLES.has(role)) throw new Error(`Unknown role "${role}". Use free, pro or team`);
  const [tier] = await rows('tiers', { name: role }, { columns: 'id' });
  const out = await updateRows('user_profiles', { tier_id: tier.id }, { id: userId });
  if (out.length !== 1) throw new Error(`No user_profiles row for ${userId}; the users.*.create event did not run`);
}

async function waitForProfile(userId) {
  for (let i = 0; i < 80; i++) {
    if ((await rows('user_profiles', { id: userId }, { columns: 'id' })).length) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No user_profiles row for ${userId} after 20 s; is the api function deployed with its users.*.create event?`);
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
  const id = crypto.randomUUID();
  const users = new Users(adminClient());
  await users.create({ userId: id, email, password, name: `verify ${role} ${counter}` });
  created.push({ id, email });
  await users.updateEmailVerification({ userId: id, emailVerification: true });
  await waitForProfile(id);
  await setTier(id, role);
  return { id, email, password, role };
}

/** A fresh password session, the one the website hands the app in its conduit:// link. */
export async function passwordSession(user) {
  const session = await new Account(adminClient()).createEmailPasswordSession({ email: user.email, password: user.password });
  if (!session.secret) throw new Error(`Password sign-in for ${user.email} returned no session secret`);
  return { userId: session.userId, sessionSecret: session.secret };
}

/** The api function as `user` (row rules on), for checks of what the server refuses. */
export async function userDb(user) {
  const { sessionSecret } = await passwordSession(user);
  const env = stackEnv();
  const client = new Client().setEndpoint(env.APPWRITE_ENDPOINT).setProject(env.APPWRITE_PROJECT_ID).setSession(sessionSecret);
  return new ConduitDb(functionTransport(client), directFiles(client));
}

/** Every object under `prefix` in a bucket: [{name, created_at, updated_at, size}] with full paths. */
export async function listObjects(prefix, bucket = BACKUP_BUCKET) {
  const out = [];
  const walk = async (dir) => {
    const entries = must(await db().storage.from(bucket).list(dir, { limit: 10_000 }), `list ${bucket}/${dir}`) ?? [];
    for (const e of entries) {
      const full = dir ? `${dir}/${e.name}` : e.name;
      if (e.id === null) await walk(full);
      else out.push({ name: full, created_at: e.created_at, updated_at: e.updated_at, size: Number(e.metadata?.size ?? 0) });
    }
  };
  await walk(prefix);
  return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.name.localeCompare(b.name));
}

async function deleteUser(id) {
  // Deleting the user removes their rows and files through the users.*.delete event; the explicit
  // removal makes the cleanup independent of that event's timing.
  const objects = await listObjects(id).catch(() => []);
  if (objects.length) await db().storage.from(BACKUP_BUCKET).remove(objects.map((o) => o.name));
  await new Users(adminClient()).delete({ userId: id });
}

/** Deletes every user this process created and their cloud backups. Lease rows go with them. */
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

/** Verify users created more than a few hours ago (runs that died before cleanup). */
export async function staleTestUsers() {
  const before = new Date(Date.now() - STALE_USER_HOURS * 3_600_000).toISOString();
  const found = await new Users(adminClient()).list({ queries: [Query.startsWith('email', 'verify-'), Query.lessThan('registration', before), Query.limit(500)] });
  return found.users.filter((u) => u.email.endsWith(`@${EMAIL_DOMAIN}`)).map((u) => ({ id: u.$id, email: u.email }));
}

/** Removes verify users (and teams they own) left behind by runs that died more than a few hours ago. */
export async function sweepStaleTestUsers() {
  await sweepStaleTeams();
  const stale = await staleTestUsers();
  for (const u of stale) await deleteUser(u.id);
  return stale.length;
}

/** The Appwrite user id for an email, or null. */
export async function userIdOf(email) {
  const found = await new Users(adminClient()).list({ queries: [Query.equal('email', [email.toLowerCase()]), Query.limit(1)] });
  return found.users[0]?.$id ?? null;
}

/** personal_vault_sessions rows (device leases) of a user, oldest first. */
export async function leaseRows(email) {
  const uid = await userIdOf(email);
  if (!uid) return [];
  const list = await rows('personal_vault_sessions', { user_id: uid }, {
    columns: 'vault_key, device_id, device_name, status, displaced_reason, displaced_by_device, file_name, file_id, location, pending_changes, acquired_at, heartbeat_at, expires_at',
    order: { column: 'acquired_at' },
  });
  return list;
}
