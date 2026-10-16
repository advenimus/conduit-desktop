import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client, Users, Account } from 'node-appwrite';

const ENDPOINT = 'http://localhost:8085/v1', PROJECT = 'conduit-dev';
const KEY = process.env.APPWRITE_SPIKE_KEY;
const admin = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY);
const users = new Users(admin);
const log = (ok, msg) => console.log(ok ? 'PASS' : 'FAIL', msg);

async function mailCode(to) {
  for (let i = 0; i < 20; i++) {
    const r = await (await fetch(`http://localhost:8025/api/v1/search?query=to:${encodeURIComponent(to)}`)).json();
    if (r.messages?.length) {
      const m = await (await fetch(`http://localhost:8025/api/v1/message/${r.messages[0].ID}`)).json();
      const code = (m.Text || m.HTML).match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('no mail');
}

const uid = crypto.randomUUID();
const email = `spike-${uid.slice(0, 8)}@example.com`;
const oldPassword = 'OldPass!12345';
const supabaseStyleHash = bcrypt.hashSync(oldPassword, 10).replace(/^\$2b\$/, '$2a$');

const u = await users.createBcryptUser({ userId: uid, email, password: supabaseStyleHash, name: 'Spike User' });
log(u.$id === uid, `user keeps Supabase UUID as ID (${u.$id})`);
await users.updateEmailVerification({ userId: uid, emailVerification: true });
await users.updateMFA({ userId: uid, mfa: true });

// Website-style sign-in: server creates the session with the API key and gets the secret.
const session = await new Account(admin).createEmailPasswordSession({ email, password: oldPassword });
log(!!session.secret, 'old bcrypt password signs in; server receives a session secret');

const userClient = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setSession(session.secret);
const acct = new Account(userClient);
try { await acct.get(); log(false, 'MFA should be required'); }
catch (e) { log(e.type === 'user_more_factors_required', `second step required (${e.type})`); }
const factors = await acct.listMFAFactors();
log(factors.email === true && factors.totp === false, `factors: ${JSON.stringify(factors)}`);
const ch = await acct.createMFAChallenge({ factor: 'email' });
const code = await mailCode(email);
await acct.updateMFAChallenge({ challengeId: ch.$id, otp: code });
const me = await acct.get();
log(me.$id === uid, 'email code completes the second step');

// Desktop handoff: website mints a one-time token, desktop turns it into its own session.
const token = await users.createToken({ userId: uid, length: 64, expire: 120 });
const deskSession = await new Account(new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY)).createSession({ userId: uid, secret: token.secret });
const desk = new Account(new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setSession(deskSession.secret));
try { await desk.get(); log(true, 'token session works without a second MFA step'); }
catch (e) { log(false, `token session blocked: ${e.type} (desktop would need its own MFA step)`); }

// JWT for calls to the website API
const jwt = await acct.createJWT();
const viaJwt = await new Account(new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setJWT(jwt.jwt)).get();
log(viaJwt.$id === uid, 'short-lived JWT identifies the user server-side');

// Suspended users
await users.updateStatus({ userId: uid, status: false });
try { await new Account(admin).createEmailPasswordSession({ email, password: oldPassword }); log(false, 'blocked user signed in'); }
catch (e) { log(true, `blocked user cannot sign in (${e.type})`); }
await users.delete({ userId: uid });
