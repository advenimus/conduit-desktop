import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client, Functions, Users, Account } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
const E = 'http://localhost:8085/v1', P = 'conduit-dev';
const KEY = process.env.APPWRITE_SPIKE_KEY;
const admin = new Client().setEndpoint(E).setProject(P).setKey(KEY);
const fns = new Functions(admin), users = new Users(admin);
const FID = 'heartbeat-spike';
await fns.delete({ functionId: FID }).catch(() => {});
await fns.create({ functionId: FID, name: FID, runtime: 'node-22', execute: ['users'], entrypoint: 'src/main.js', commands: 'npm install', timeout: 15, scopes: ['rows.read', 'tables.read'] });
await fns.createVariable({ functionId: FID, variableId: 'api', key: 'CONDUIT_API_ENDPOINT', value: 'http://appwrite-api/v1', secret: false });
const dep = await fns.createDeployment({ functionId: FID, code: InputFile.fromPath(process.env.FN_TARBALL, 'code.tar.gz'), activate: true });
const tb = Date.now();
for (;;) {
  const d = await fns.getDeployment({ functionId: FID, deploymentId: dep.$id });
  if (d.status === 'ready') break;
  if (d.status === 'failed') { console.log('build failed', d.buildLogs?.slice(-800)); process.exit(1); }
  if (Date.now() - tb > 300000) { console.log('build timeout', d.status); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`build ready in ${Math.round((Date.now() - tb) / 1000)} s`);

const uid = crypto.randomUUID(), email = `f-${uid.slice(0, 8)}@example.com`;
await users.create({ userId: uid, email, password: 'Passw0rd!long' });
const s = await new Account(admin).createEmailPasswordSession({ email, password: 'Passw0rd!long' });
const userFns = new Functions(new Client().setEndpoint(E).setProject(P).setSession(s.secret));
const times = [];
for (let i = 0; i < 25; i++) {
  const t0 = Date.now();
  const ex = await userFns.createExecution({ functionId: FID, body: '{}', async: false, method: 'POST', path: '/heartbeat' });
  times.push(Date.now() - t0);
  if (i === 0) console.log('first response', ex.responseStatusCode, ex.responseBody.slice(0, 160));
}
const warm = times.slice(1).sort((a, b) => a - b);
console.log(`cold first call ${times[0]} ms; warm median ${warm[Math.floor(warm.length / 2)]} ms, p90 ${warm[Math.floor(warm.length * 0.9)]} ms`);
const noAuth = await new Functions(new Client().setEndpoint(E).setProject(P)).createExecution({ functionId: FID, body: '{}', async: false }).catch((e) => e);
console.log('anonymous call:', noAuth.responseStatusCode ?? noAuth.code, noAuth.type ?? '');
await users.delete({ userId: uid });
