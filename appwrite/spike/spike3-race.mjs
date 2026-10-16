import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client, TablesDB, Query, ID } from 'node-appwrite';
const KEY = process.env.APPWRITE_SPIKE_KEY;
const mk = () => new TablesDB(new Client().setEndpoint('http://localhost:8085/v1').setProject('conduit-dev').setKey(KEY));
const D = 'spike', T = 'leases', G = 'guards';
const log = (ok, msg) => console.log(ok ? 'PASS' : 'FAIL', msg);
const hid = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 32);
const db0 = mk();

await db0.deleteTable({ databaseId: D, tableId: G }).catch(() => {});
await db0.createTable({ databaseId: D, tableId: G, name: G, rowSecurity: false, permissions: [] });
await db0.createStringColumn({ databaseId: D, tableId: G, key: 'user_id', size: 64, required: false });
await db0.createIntegerColumn({ databaseId: D, tableId: G, key: 'rev', required: false });
for (let i = 0; i < 40; i++) { const t = await db0.getTable({ databaseId: D, tableId: G }); if (t.columns.every((c) => c.status === 'available')) break; await new Promise((r) => setTimeout(r, 300)); }

const active = (db, user) => db.listRows({ databaseId: D, tableId: T, queries: [Query.equal('user_id', [user]), Query.equal('status', ['active']), Query.limit(100)] });

// Naive check-then-act inside a transaction: cap 1 active lease per account.
async function naive(user, i) {
  const db = mk();
  const tx = await db.createTransaction();
  const cur = await active(db, user);
  if (cur.total >= 1) { await db.updateTransaction({ transactionId: tx.$id, rollback: true }); return false; }
  await db.createRow({ databaseId: D, tableId: T, rowId: ID.unique(), data: { user_id: user, vault_key: `v${i}`, device_id: `d${i}`, status: 'active' }, transactionId: tx.$id });
  await db.updateTransaction({ transactionId: tx.$id, commit: true });
  return true;
}

// Guarded: claim the next revision of the account's guard (deterministic row ID) in the same transaction.
async function latestRev(db, user) {
  const r = await db.listRows({ databaseId: D, tableId: G, queries: [Query.equal('user_id', [user]), Query.orderDesc('rev'), Query.limit(1)] });
  return r.rows[0]?.rev ?? 0;
}
async function guarded(user, i) {
  const db = mk();
  for (let attempt = 0; attempt < 30; attempt++) {
    const rev = await latestRev(db, user);
    const cur = await active(db, user);
    if (cur.total >= 1) return 'denied';
    const tx = await db.createTransaction();
    try {
      await db.createRow({ databaseId: D, tableId: G, rowId: hid(user, rev + 1), data: { user_id: user, rev: rev + 1 }, transactionId: tx.$id });
      await db.createRow({ databaseId: D, tableId: T, rowId: ID.unique(), data: { user_id: user, vault_key: `v${i}`, device_id: `d${i}`, status: 'active' }, transactionId: tx.$id });
      await db.updateTransaction({ transactionId: tx.$id, commit: true });
      return 'won';
    } catch (e) {
      await db.updateTransaction({ transactionId: tx.$id, rollback: true }).catch(() => {});
      if (e.code !== 409) throw e;
      await new Promise((r) => setTimeout(r, Math.random() * 40));
    }
  }
  return 'gave-up';
}

const N = 20;
const u1 = `naive-${crypto.randomUUID().slice(0, 8)}`;
await Promise.allSettled(Array.from({ length: N }, (_, i) => naive(u1, i)));
const n1 = (await active(db0, u1)).total;
console.log(`naive: ${n1} of ${N} parallel callers got a lease (cap is 1)`);

for (let round = 0; round < 5; round++) {
  const u2 = `guard-${crypto.randomUUID().slice(0, 8)}`;
  const t0 = Date.now();
  const res = await Promise.allSettled(Array.from({ length: N }, (_, i) => guarded(u2, i)));
  const n2 = (await active(db0, u2)).total;
  const outcome = res.map((r) => r.status === 'fulfilled' ? r.value : `err:${r.reason?.type ?? r.reason?.message}`);
  const counts = outcome.reduce((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
  log(n2 === 1, `guarded round ${round + 1}: ${n2} lease(s) for ${N} parallel callers ${JSON.stringify(counts)} in ${Date.now() - t0} ms`);
}
