import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client, Users, Account } from 'node-appwrite';
const ENDPOINT = 'http://localhost:8085/v1', PROJECT = 'conduit-dev';
const KEY = process.env.APPWRITE_SPIKE_KEY;
const admin = new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setKey(KEY);
const users = new Users(admin);
const log = (ok, msg) => console.log(ok ? 'PASS' : 'FAIL', msg);
const asUser = (secret) => new Account(new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setSession(secret));

const uid = crypto.randomUUID();
await users.create({ userId: uid, email: `h-${uid.slice(0, 8)}@example.com`, password: 'Passw0rd!long' });
await users.updateEmailVerification({ userId: uid, emailVerification: true });
await users.updateMFA({ userId: uid, mfa: true });

const s = await users.createSession({ userId: uid });
try { const me = await asUser(s.secret).get(); log(me.$id === uid, 'server-created session (users.createSession) skips the second step'); }
catch (e) { log(false, `server-created session also needs MFA: ${e.type}`); }

const j = await users.createJWT({ userId: uid, sessionId: s.$id, duration: 900 });
const viaJwt = await new Account(new Client().setEndpoint(ENDPOINT).setProject(PROJECT).setJWT(j.jwt)).get().catch((e) => e);
log(viaJwt.$id === uid, `JWT from server identifies the user (${viaJwt.$id ?? viaJwt.type})`);
const sessions = await users.listSessions({ userId: uid });
log(true, `session expires ${sessions.sessions[0].expire}, factors ${JSON.stringify(sessions.sessions[0].factors)}`);
await users.delete({ userId: uid });
