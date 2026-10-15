import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client as AdminClient, Users, TablesDB, Account as AdminAccount, Permission, Role, ID } from 'node-appwrite';
import { Client, Realtime, Query } from 'appwrite';
const E = 'http://localhost:8085/v1', P = 'conduit-dev';
const KEY = process.env.APPWRITE_SPIKE_KEY;
const admin = new AdminClient().setEndpoint(E).setProject(P).setKey(KEY);
const users = new Users(admin), db = new TablesDB(admin);
const log = (ok, msg) => console.log(ok ? 'PASS' : 'FAIL', msg);
console.log('node', process.version, 'global WebSocket:', typeof WebSocket);

const uid = crypto.randomUUID(), other = crypto.randomUUID();
await users.create({ userId: uid, email: `r-${uid.slice(0, 8)}@example.com`, password: 'Passw0rd!long' });
await users.create({ userId: other, email: `r-${other.slice(0, 8)}@example.com`, password: 'Passw0rd!long' });
const s = await new AdminAccount(admin).createEmailPasswordSession({ email: `r-${uid.slice(0, 8)}@example.com`, password: 'Passw0rd!long' });

const client = new Client().setEndpoint(E).setProject(P).setSession(s.secret);
const rt = new Realtime(client);
const got = [];
const sub = await rt.subscribe('tablesdb.spike.tables.leases.rows', (ev) => got.push(ev), [Query.equal('device_id', ['A'])]);
await new Promise((r) => setTimeout(r, 1500));

const mine = (dev) => ({ user_id: uid, vault_key: `vk-${dev}-${crypto.randomUUID().slice(0, 6)}`, device_id: dev, status: 'active' });
const rowA = await db.createRow({ databaseId: 'spike', tableId: 'leases', rowId: ID.unique(), data: mine('A'), permissions: [Permission.read(Role.user(uid))] });
await db.createRow({ databaseId: 'spike', tableId: 'leases', rowId: ID.unique(), data: mine('B'), permissions: [Permission.read(Role.user(uid))] });
await db.createRow({ databaseId: 'spike', tableId: 'leases', rowId: ID.unique(), data: { ...mine('A'), user_id: other }, permissions: [Permission.read(Role.user(other))] });
const t0 = Date.now();
await db.updateRow({ databaseId: 'spike', tableId: 'leases', rowId: rowA.$id, data: { status: 'displaced' } });
for (let i = 0; i < 40 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 1000));

const devices = got.map((g) => g.payload.device_id);
log(got.length === 2, `got ${got.length} events (want create + update of my device A only)`);
log(devices.every((d) => d === 'A'), `server-side filter by device works: ${JSON.stringify(devices)}`);
log(got.every((g) => g.payload.user_id === uid), 'no events for rows I cannot read');
log(got.some((g) => g.events.some((e) => e.endsWith('.update')) && g.payload.status === 'displaced'), `update event arrives with new values (~${Date.now() - t0} ms incl. wait)`);
await sub.close?.();
await users.delete({ userId: uid }); await users.delete({ userId: other });
process.exit(0);
