import { timingSafeEqual } from 'node:crypto';
import { Client, Query, Storage, TablesDB, Users } from 'node-appwrite';
import type { Caller } from '../api/context.ts';
import { type ApiRequest, type Deps, handle } from '../api/handler.ts';
import { nightly, userCreated, userDeleted, type NewUser } from '../api/jobs.ts';
import { AppwriteStore } from '../api/store.ts';
import { BUCKETS, DATABASE_ID, GUARDS_TABLE, tableSpec } from '../schema/tables.ts';
import { appwriteEffects } from './effects.ts';
import { AppwriteDirectory, AppwriteFiles } from './services.ts';

// The single Appwrite function behind the apps: HTTP executions carry PostgREST-style requests,
// user events replace the auth.users triggers, and the daily schedule replaces pg_cron.

interface FnContext {
  req: { headers: Record<string, string>; bodyText?: string; bodyJson?: unknown };
  res: { json: (body: unknown, status?: number) => unknown };
  log: (msg: unknown) => void;
  error: (msg: unknown) => void;
}

const env = process.env;

function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function build(key: string): { client: Client; deps: Deps } {
  const client = new Client()
    .setEndpoint(env.CONDUIT_API_ENDPOINT ?? env.APPWRITE_FUNCTION_API_ENDPOINT ?? '')
    .setProject(env.APPWRITE_FUNCTION_PROJECT_ID ?? '')
    .setKey(key);
  const store = new AppwriteStore(new TablesDB(client));
  const files = new AppwriteFiles(client);
  return {
    client,
    deps: { store, files, directory: new AppwriteDirectory(client), effects: appwriteEffects(env, client, store, files), abuseChecks: env.CONDUIT_ABUSE_CHECKS !== 'off' },
  };
}

async function callerFor(client: Client, headers: Record<string, string>): Promise<Caller> {
  const uid = headers['x-appwrite-user-id'];
  if (uid) {
    const loadEmail = async () => (await new Users(client).get({ userId: uid })).email || null;
    return { role: 'authenticated', uid, email: null, loadEmail, ip: headers['x-appwrite-client-ip'] || null };
  }
  if (sameSecret(headers['x-conduit-service'], env.CONDUIT_SERVICE_SECRET)) return { role: 'service', uid: null, email: null };
  return { role: 'anon', uid: null, email: null };
}

/** Old guard revisions are only needed while a writer might still race on them; a month-old scope is idle. */
async function pruneGuards(db: TablesDB, now: number): Promise<number> {
  const old = await db.listRows({
    databaseId: DATABASE_ID, tableId: GUARDS_TABLE,
    queries: [Query.lessThan('$createdAt', new Date(now - 86_400_000).toISOString()), Query.limit(5000)], total: false,
  });
  const scopes = new Set(old.rows.map((r) => (r as unknown as { scope: string }).scope));
  let removed = 0;
  for (const scope of scopes) {
    const latest = await db.listRows({ databaseId: DATABASE_ID, tableId: GUARDS_TABLE, queries: [Query.equal('scope', [scope]), Query.orderDesc('rev'), Query.limit(1)], total: false });
    const max = (latest.rows[0] as unknown as { rev: number } | undefined)?.rev ?? 0;
    const monthAgo = now - 30 * 86_400_000;
    const doomed = old.rows.filter((r) => {
      const g = r as unknown as { scope: string; rev: number; $createdAt: string };
      return g.scope === scope && (g.rev < max || Date.parse(g.$createdAt) < monthAgo);
    });
    for (const r of doomed) {
      await db.deleteRow({ databaseId: DATABASE_ID, tableId: GUARDS_TABLE, rowId: r.$id });
      removed++;
    }
  }
  return removed;
}

/** Bytes whose upload never committed (a lost race or a crash between the two steps). */
async function pruneOrphanFiles(client: Client, deps: Deps, now: number): Promise<number> {
  const storage = new Storage(client);
  const known = new Set((await deps.store.list(tableSpec('cloud_files'), [])).map((r) => r.file_id as string));
  let removed = 0;
  for (const bucket of BUCKETS) {
    let cursor: string | undefined;
    for (;;) {
      const page = await storage.listFiles({ bucketId: bucket.id, queries: [Query.limit(100), ...(cursor ? [Query.cursorAfter(cursor)] : [])] });
      for (const f of page.files) {
        if (!known.has(f.$id) && Date.parse(f.$createdAt) < now - 3_600_000) {
          await storage.deleteFile({ bucketId: bucket.id, fileId: f.$id });
          removed++;
        }
      }
      if (page.files.length < 100) break;
      cursor = page.files[page.files.length - 1]!.$id;
    }
  }
  return removed;
}

export default async function main({ req, res, error }: FnContext): Promise<unknown> {
  const key = req.headers['x-appwrite-key'];
  if (!key) return res.json({ data: null, error: { code: 'XX000', message: 'function key missing', details: null, hint: null } }, 500);
  const { client, deps } = build(key);
  const trigger = req.headers['x-appwrite-trigger'];

  try {
    if (trigger === 'event') {
      const event = req.headers['x-appwrite-event'] ?? '';
      const user = (req.bodyJson ?? JSON.parse(req.bodyText || '{}')) as NewUser;
      if (/^users\.[^.]+\.create$/.test(event)) await userCreated(deps, user);
      else if (/^users\.[^.]+\.delete$/.test(event)) await userDeleted(deps, user.$id);
      return res.json({ ok: true, event });
    }
    if (trigger === 'schedule') {
      const now = Date.now();
      const counts = await nightly(deps);
      counts.guards = await pruneGuards(new TablesDB(client), now);
      counts.orphan_files = await pruneOrphanFiles(client, deps, now);
      return res.json(counts);
    }

    const caller = await callerFor(client, req.headers);
    let body: ApiRequest;
    try {
      body = JSON.parse(req.bodyText || '{}') as ApiRequest;
    } catch {
      return res.json({ data: null, error: { code: 'PGRST102', message: 'Empty or invalid json', details: null, hint: null } }, 400);
    }
    const out = await handle(body, caller, deps);
    return res.json(out.body, out.status);
  } catch (e) {
    error(e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
    return res.json({ data: null, error: { code: 'XX000', message: 'internal error', details: null, hint: null } }, 500);
  }
}
