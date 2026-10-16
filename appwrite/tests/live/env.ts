import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stackDir } from '../../scripts/setup-local.ts';
import bcrypt from 'bcryptjs';
import { Client, Users } from 'node-appwrite';
import { ConduitDb } from '../../src/client/index.ts';
import { directFiles, functionTransport } from '../../src/client/appwrite-transport.ts';

// Live tests run against the local Appwrite stack. Settings come from the env file the deploy step
// writes (CONDUIT_APPWRITE_ENV, default <stack folder>/conduit-dev.env, see scripts/setup-local.ts).

function loadEnv(): Record<string, string> {
  const file = process.env.CONDUIT_APPWRITE_ENV ?? join(stackDir(), 'conduit-dev.env');
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export const ENV = loadEnv();
export const adminClient = () => new Client().setEndpoint(ENV.APPWRITE_ENDPOINT!).setProject(ENV.APPWRITE_PROJECT_ID!).setKey(ENV.APPWRITE_API_KEY!);
export const service = () => new ConduitDb(functionTransport(adminClient(), { serviceSecret: ENV.CONDUIT_SERVICE_SECRET }));

export interface TestUser {
  id: string;
  email: string;
  password: string;
  session: string;
  db: ConduitDb;
  client: Client;
}

const created: string[] = [];

export async function makeUser(label: string, tier: 'free' | 'pro' | 'team' = 'free'): Promise<TestUser> {
  const id = randomUUID();
  const email = `live-${label}-${id.slice(0, 8)}@example.com`;
  const password = `pw-${randomUUID()}`;
  const users = new Users(adminClient());
  // Bcrypt plus a server-made session, the same path imported accounts take, and it keeps these tests off password hashing.
  await users.createBcryptUser({ userId: id, email, password: bcrypt.hashSync(password, 4), name: label });
  created.push(id);
  const session = await users.createSession({ userId: id });
  const client = new Client().setEndpoint(ENV.APPWRITE_ENDPOINT!).setProject(ENV.APPWRITE_PROJECT_ID!).setSession(session.secret);
  // The users.*.create event writes the profile asynchronously; wait for it, then set the plan.
  const svc = service();
  for (let i = 0; i < 60; i++) {
    const { data } = await svc.from('user_profiles').select('id').eq('id', id).maybeSingle();
    if (data) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (tier !== 'free') {
    const { data: t } = await svc.from('tiers').select('id').eq('name', tier).single();
    const { error } = await svc.from('user_profiles').update({ tier_id: t.id }).eq('id', id);
    if (error) throw new Error(error.message);
  }
  return { id, email, password, session: session.secret, db: new ConduitDb(functionTransport(client), directFiles(client)), client };
}

export async function cleanupUsers(): Promise<void> {
  const users = new Users(adminClient());
  for (const id of created.splice(0)) await users.delete({ userId: id }).catch(() => undefined);
}
