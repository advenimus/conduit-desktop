import { parseArgs } from 'node:util';
import { AppwriteException, Client, Compression, Functions, Runtime, Storage, TablesDB } from 'node-appwrite';
import { InputFile } from 'node-appwrite/file';
import { handle } from '../src/api/handler.ts';
import { AppwriteStore } from '../src/api/store.ts';
import { SEED_CONFIG, SEED_TIERS } from '../src/schema/seed.ts';
import { BUCKETS, DATABASE_ID, GUARDS_TABLE, TABLES } from '../src/schema/tables.ts';
import type { ColumnSpec, TableSpec } from '../src/schema/types.ts';
import { buildFunctionTarball } from './lib/build.ts';

// Applies the schema, buckets and the api function to an Appwrite project. Safe to run again: it
// only creates what is missing. Env: APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY.
// Function variables come from CONDUIT_SERVICE_SECRET, CONDUIT_API_ENDPOINT and RESEND_* when set.

const { values: flags } = parseArgs({
  options: {
    seed: { type: 'boolean', default: false },
    'skip-function': { type: 'boolean', default: false },
    'function-only': { type: 'boolean', default: false },
  },
});

const env = process.env;
for (const k of ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY']) {
  if (!env[k]) throw new Error(`${k} is required`);
}
const client = new Client().setEndpoint(env.APPWRITE_ENDPOINT!).setProject(env.APPWRITE_PROJECT_ID!).setKey(env.APPWRITE_API_KEY!);
const db = new TablesDB(client);
const log = (msg: string) => console.log(`[deploy] ${msg}`);
const missing = (e: unknown) => e instanceof AppwriteException && e.code === 404;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const FUNCTION_ID = 'api';

async function ensureDatabase(): Promise<void> {
  try {
    await db.get({ databaseId: DATABASE_ID });
  } catch (e) {
    if (!missing(e)) throw e;
    await db.create({ databaseId: DATABASE_ID, name: 'Conduit' });
    log(`created database ${DATABASE_ID}`);
  }
}

async function createColumn(table: string, key: string, col: ColumnSpec): Promise<void> {
  const base = { databaseId: DATABASE_ID, tableId: table, key, required: false };
  switch (col.type) {
    case 'uuid':
      return void (await db.createVarcharColumn({ ...base, size: 36 }));
    case 'varchar':
      return void (await db.createVarcharColumn({ ...base, size: col.size ?? 255 }));
    case 'text':
      return void (await db.createTextColumn(base));
    case 'longtext':
    case 'json':
      return void (await db.createLongtextColumn(base));
    case 'int':
      return void (await db.createIntegerColumn(base));
    case 'bigint':
      return void (await db.createBigIntColumn(base));
    case 'float':
      return void (await db.createFloatColumn(base));
    case 'bool':
      return void (await db.createBooleanColumn(base));
    case 'datetime':
      return void (await db.createDatetimeColumn(base));
    case 'text[]':
      return void (await db.createVarcharColumn({ ...base, size: 1024, array: true }));
  }
}

async function waitAvailable(table: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const t = await db.getTable({ databaseId: DATABASE_ID, tableId: table });
    const states = [...t.columns.map((c) => (c as { status: string }).status), ...t.indexes.map((x) => x.status)];
    if (states.some((s) => s === 'failed')) throw new Error(`a column or index of ${table} failed: ${JSON.stringify(t.columns.concat(t.indexes as never[]).filter((c) => (c as { status: string }).status === 'failed'))}`);
    if (states.every((s) => s === 'available')) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${table}`);
}

async function ensureTable(spec: Pick<TableSpec, 'name' | 'columns' | 'primaryKey' | 'unique' | 'indexes' | 'realtime'>): Promise<void> {
  let existing;
  try {
    existing = await db.getTable({ databaseId: DATABASE_ID, tableId: spec.name });
  } catch (e) {
    if (!missing(e)) throw e;
    await db.createTable({ databaseId: DATABASE_ID, tableId: spec.name, name: spec.name, rowSecurity: Boolean(spec.realtime), permissions: [] });
    log(`created table ${spec.name}`);
    existing = await db.getTable({ databaseId: DATABASE_ID, tableId: spec.name });
  }
  const have = new Set(existing.columns.map((c) => (c as { key: string }).key));
  const keyCol = spec.primaryKey.length === 1 ? spec.primaryKey[0] : null;
  for (const [name, col] of Object.entries(spec.columns)) {
    if (name === keyCol || have.has(name)) continue;
    await createColumn(spec.name, name, col);
    log(`  + ${spec.name}.${name} (${col.type})`);
  }
  await waitAvailable(spec.name);

  const haveIdx = new Set(existing.indexes.map((x) => x.key));
  const attr = (c: string) => (c === keyCol ? '$id' : c);
  const wanted: { key: string; type: 'key' | 'unique'; columns: string[] }[] = [];
  for (const cols of spec.indexes ?? []) wanted.push({ key: `ix_${cols.join('_')}`.slice(0, 36), type: 'key', columns: cols.map(attr) });
  for (const cols of spec.unique ?? []) {
    // Nullable unique columns allow many NULLs in Postgres; those stay a plain index and the api enforces them.
    const allRequired = cols.every((c) => !spec.columns[c]!.nullable);
    wanted.push({ key: `${allRequired ? 'uq' : 'ix'}_${cols.join('_')}`.slice(0, 36), type: allRequired ? 'unique' : 'key', columns: cols.map(attr) });
  }
  if (spec.primaryKey.length > 1) wanted.push({ key: `pk_${spec.primaryKey.join('_')}`.slice(0, 36), type: 'unique', columns: [...spec.primaryKey] });
  // MariaDB refuses a second index over the same columns; keep the unique one.
  const sameCols = (a: { columns: string[] }, b: { columns: string[] }) => a.columns.join() === b.columns.join();
  const distinct = wanted.filter((idx, i) => !wanted.some((o, j) => j !== i && sameCols(idx, o) && (o.type === 'unique' && idx.type === 'key' || (o.type === idx.type && j < i))));
  for (const idx of distinct) {
    if (haveIdx.has(idx.key) || idx.columns.every((c) => c === '$id')) continue;
    await db.createIndex({ databaseId: DATABASE_ID, tableId: spec.name, key: idx.key, type: idx.type as never, columns: idx.columns });
    log(`  + index ${spec.name}.${idx.key}`);
  }
  await waitAvailable(spec.name);
}

async function ensureBuckets(): Promise<void> {
  const storage = new Storage(client);
  for (const b of BUCKETS) {
    try {
      const have = await storage.getBucket({ bucketId: b.id });
      const want = 'permissions' in b ? [...b.permissions] : [];
      if (JSON.stringify(have.$permissions) !== JSON.stringify(want)) {
        await storage.updateBucket({ bucketId: b.id, name: b.name, permissions: want, fileSecurity: true, enabled: true, maximumFileSize: b.maxBytes });
        log(`updated bucket ${b.id} permissions`);
      }
    } catch (e) {
      if (!missing(e)) throw e;
      await storage.createBucket({
        bucketId: b.id, name: b.name, permissions: 'permissions' in b ? [...b.permissions] : [], fileSecurity: true, enabled: true, maximumFileSize: b.maxBytes,
        compression: Compression.None, encryption: true, antivirus: false,
      });
      log(`created bucket ${b.id}`);
    }
  }
}

async function ensureFunction(): Promise<void> {
  const fns = new Functions(client);
  const settings = {
    functionId: FUNCTION_ID,
    name: 'Conduit API',
    runtime: Runtime.Node22,
    execute: ['users'],
    events: ['users.*.create', 'users.*.delete'],
    schedule: '0 3 * * *',
    timeout: 30,
    enabled: true,
    logging: true,
    entrypoint: 'main.js',
    commands: '',
    scopes: [
      'users.read', 'users.write', 'teams.read', 'teams.write', 'databases.read', 'tables.read', 'rows.read', 'rows.write',
      'buckets.read', 'files.read', 'files.write',
    ] as never[],
  };
  try {
    await fns.get({ functionId: FUNCTION_ID });
    await fns.update(settings);
  } catch (e) {
    if (!missing(e)) throw e;
    await fns.create(settings);
    log(`created function ${FUNCTION_ID}`);
  }
  const vars = await fns.listVariables({ functionId: FUNCTION_ID });
  for (const key of ['CONDUIT_SERVICE_SECRET', 'CONDUIT_API_ENDPOINT', 'CONDUIT_ABUSE_CHECKS', 'RESEND_API_KEY', 'RESEND_CONTACTS_API_KEY', 'RESEND_SEGMENT_ID', 'FEEDBACK_FROM', 'FEEDBACK_TO']) {
    const value = env[key];
    if (!value) continue;
    const found = vars.variables.find((v) => v.key === key);
    const secret = key !== 'CONDUIT_API_ENDPOINT' && key !== 'CONDUIT_ABUSE_CHECKS';
    if (found) await fns.updateVariable({ functionId: FUNCTION_ID, variableId: found.$id, key, value, secret });
    else await fns.createVariable({ functionId: FUNCTION_ID, variableId: key.toLowerCase().replace(/_/g, '-'), key, value, secret });
  }
  const tarball = await buildFunctionTarball();
  const dep = await fns.createDeployment({ functionId: FUNCTION_ID, code: InputFile.fromPath(tarball, 'api.tar.gz'), activate: true });
  for (let i = 0; i < 300; i++) {
    const d = await fns.getDeployment({ functionId: FUNCTION_ID, deploymentId: dep.$id });
    if (d.status === 'ready') {
      log(`function deployed (${dep.$id})`);
      return;
    }
    if (d.status === 'failed') throw new Error(`deployment failed:\n${d.buildLogs}`);
    await sleep(1000);
  }
  throw new Error('deployment timed out');
}

async function seed(): Promise<void> {
  const deps = {
    store: new AppwriteStore(db),
    files: { put: async () => {}, get: async () => null, delete: async () => {}, staged: async () => null, allowRead: async () => {} },
    directory: { exists: async () => true, emails: async () => new Map<string, string>() },
    effects: { syncVaultMembership: async () => {}, newUserProfile: async () => {}, feedbackSubmitted: async () => {}, fileReleased: async () => {} },
  };
  const service = { role: 'service' as const, uid: null, email: null };
  for (const [table, rows] of [['tiers', SEED_TIERS], ['app_config', SEED_CONFIG]] as const) {
    for (const row of rows) {
      const r = await handle({ kind: 'query', op: 'upsert', table, rows: row, ignoreDuplicates: true }, service, deps);
      if (r.body.error) throw new Error(`seed ${table}: ${r.body.error.message}`);
    }
  }
  log('seeded tiers and app_config');
}

if (!flags['function-only']) {
  await ensureDatabase();
  for (const spec of TABLES) await ensureTable(spec);
  await ensureTable({ name: GUARDS_TABLE, primaryKey: ['$id'], columns: { scope: { type: 'varchar', size: 220, nullable: false }, rev: { type: 'int', nullable: false } }, indexes: [['scope', 'rev']] });
  await ensureBuckets();
}
if (flags.seed) await seed();
if (!flags['skip-function']) await ensureFunction();
log('done');
