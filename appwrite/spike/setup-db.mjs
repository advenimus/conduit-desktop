import fs from 'node:fs';
import { Client, TablesDB } from 'node-appwrite';
const KEY = process.env.APPWRITE_SPIKE_KEY;
const admin = new Client().setEndpoint('http://localhost:8085/v1').setProject('conduit-dev').setKey(KEY);
const db = new TablesDB(admin);
const D = 'spike', T = 'leases';
await db.delete({ databaseId: D }).catch(() => {});
await db.create({ databaseId: D, name: 'spike' });
await db.createTable({ databaseId: D, tableId: T, name: T, rowSecurity: true, permissions: [] });
for (const k of ['user_id', 'vault_key', 'device_id', 'lease_id', 'status'])
  await db.createVarcharColumn?.({ databaseId: D, tableId: T, key: k, size: 64, required: false })
    ?? await db.createStringColumn({ databaseId: D, tableId: T, key: k, size: 64, required: false });
await db.createIntegerColumn({ databaseId: D, tableId: T, key: 'heartbeat', required: false });
for (let i = 0; i < 40; i++) {
  const t = await db.getTable({ databaseId: D, tableId: T });
  if (t.columns.every((c) => c.status === 'available')) break;
  await new Promise((r) => setTimeout(r, 500));
}
await db.createIndex({ databaseId: D, tableId: T, key: 'one_holder', type: 'unique', columns: ['user_id', 'vault_key'] });
console.log('db ready');
