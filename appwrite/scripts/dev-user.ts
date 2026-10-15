import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client, Users } from 'node-appwrite';
import { functionTransport } from '../src/client/appwrite-transport.ts';
import { ConduitDb } from '../src/client/index.ts';

// Creates (or resets) a local test account: node scripts/dev-user.ts --email a@b.c --password pw [--tier pro] [--mfa]
// Env: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY, CONDUIT_SERVICE_SECRET (the conduit-dev.env file).

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
    tier: { type: 'string', default: 'free' },
    mfa: { type: 'boolean', default: false },
  },
});
if (!values.email || !values.password) throw new Error('--email and --password are required');
const email = values.email.toLowerCase();
const password = values.password;

const env = process.env;
const client = new Client().setEndpoint(env.APPWRITE_ENDPOINT!).setProject(env.APPWRITE_PROJECT_ID!).setKey(env.APPWRITE_API_KEY!);
const users = new Users(client);
const db = new ConduitDb(functionTransport(client, { serviceSecret: env.CONDUIT_SERVICE_SECRET }));

const existing = (await users.list({ search: email })).users.find((u) => u.email === email);
const id = existing?.$id ?? randomUUID();
if (existing) {
  await users.updatePassword({ userId: id, password });
} else {
  await users.create({ userId: id, email, password, name: values.name ?? email.split('@')[0] });
}
await users.updateEmailVerification({ userId: id, emailVerification: true });
await users.updateMFA({ userId: id, mfa: values.mfa });

for (let i = 0; i < 40; i++) {
  if ((await db.from('user_profiles').select('id').eq('id', id).maybeSingle()).data) break;
  await new Promise((r) => setTimeout(r, 250));
}
const tier = await db.from('tiers').select('id').eq('name', values.tier).single();
if (tier.error) throw new Error(`unknown tier ${values.tier}`);
const up = await db.from('user_profiles').update({ tier_id: tier.data.id }).eq('id', id);
if (up.error) throw new Error(up.error.message);
console.log(JSON.stringify({ id, email, tier: values.tier, mfa: values.mfa }));
