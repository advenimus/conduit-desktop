// Creates or updates a test account on the LOCAL Supabase (the one `npm run dev:electron`
// and iOS Debug builds use) and can sign the running Conduit Dev app in with it.
//
//   npm run dev:account -- --email you@example.com --plan pro [--password <pw>] [--signin]
//
// Without --password a new account gets a random one, printed once. An existing account
// keeps its password unless --password is given. Refuses anything but a local stack.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API_URL, getServiceKey, passwordSession, setTier, sqlJson } from '../verify/lib/supabase.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLANS = new Set(['free', 'pro', 'team']);

function parseArgs(argv) {
  const out = { plan: 'pro', signin: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--signin') out.signin = true;
    else if (arg === '--email' || arg === '--plan' || arg === '--password') out[arg.slice(2)] = argv[++i];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!out.email || !/^[^\s@]+@[^\s@]+$/.test(out.email)) throw new Error('Give --email you@example.com');
  if (!PLANS.has(out.plan)) throw new Error('--plan must be free, pro or team');
  if (out.password !== undefined && out.password.length < 6) throw new Error('--password needs at least 6 characters');
  return { ...out, email: out.email.toLowerCase() };
}

async function admin(pathname, init = {}) {
  const key = await getServiceKey();
  const res = await fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname}: HTTP ${res.status} ${body.msg ?? body.message ?? ''}`);
  return body;
}

async function upsertUser({ email, password }) {
  const [existing] = await sqlJson("select id from auth.users where lower(email) = :'email'", { email });
  if (existing) {
    if (password) await admin(`/auth/v1/admin/users/${existing.id}`, { method: 'PUT', body: JSON.stringify({ password }) });
    return { id: existing.id, created: false, password };
  }
  const chosen = password ?? crypto.randomBytes(12).toString('base64url');
  const user = await admin('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: chosen, email_confirm: true }),
  });
  return { id: user.id, created: true, password: chosen };
}

// A second launch of the dev build hands the link to the running one and exits.
function signInRunningApp(accessToken, refreshToken) {
  const rel = fs.readFileSync(path.join(REPO, 'node_modules/electron/path.txt'), 'utf8').trim();
  const electron = path.join(REPO, 'node_modules/electron/dist', rel);
  const link = `conduit://auth/callback#access_token=${accessToken}&refresh_token=${refreshToken}&token_type=bearer`;
  execFileSync(electron, ['.', link], { cwd: REPO, env: { ...process.env, CONDUIT_ENV: 'preview' }, stdio: 'ignore', timeout: 30_000 });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_URL)) throw new Error(`Refusing: ${API_URL} is not a local stack`);
  const user = await upsertUser(opts);
  await setTier(user.id, opts.plan);
  console.log(`${user.created ? 'Created' : 'Updated'} ${opts.email} on the local server (plan: ${opts.plan}).`);
  if (user.created && !opts.password) console.log(`Password: ${user.password}`);
  if (opts.signin) {
    if (!user.password) throw new Error('--signin on an existing account needs --password');
    const { accessToken, refreshToken } = await passwordSession({ email: opts.email, password: user.password });
    signInRunningApp(accessToken, refreshToken);
    console.log('Signed in the running Conduit Dev app.');
  }
}

main().catch((err) => {
  console.error(`dev:account failed: ${err.message}`);
  process.exit(1);
});
