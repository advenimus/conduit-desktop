// @vitest-environment node
// Cross-platform fixtures for the Swift port (spec 13.2): small .conduit files plus expected.json
// holding what this core computes from them (load, G1 genesis, legacy absorb, epoch alignment,
// merge, materialize, conflicts). The iOS repo copies __vectors__/fixtures with
// scripts/sync-vectors.sh and asserts identical results.
// UPDATE_SYNC_FIXTURES=1 regenerates files and expectations; UPDATE_SYNC_FIXTURES=expected
// recomputes expected.json from the committed files; otherwise the committed expectations must
// equal a fresh computation, so desktop CI catches drift.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { captureFullPass } from '../capture-local.js';
import { captureLegacy } from '../capture-legacy.js';
import { listConflicts } from '../conflicts.js';
import { canonicalDump, digestState } from '../digest.js';
import { genesisFromContent } from '../genesis.js';
import { deriveEpochKeys, genesisIdOf, lineageIdFromSalt, makeImplicitProvider } from '../hashing.js';
import { alignEpoch, buildKeyRing, currentEpochId, openSecret, type AlignResult } from '../key-epoch.js';
import { materialize } from '../materialize.js';
import { merge } from '../merge.js';
import { hasSyncTables, readSyncFormat } from '../schema.js';
import { recoveryFrom, rowKeyStr } from '../state-view.js';
import { loadContent, loadFile, saveState } from '../state-store.js';
import { encodeValue } from '../value-codec.js';
import type {
  CaptureResult, ConflictGroup, ConflictItem, ConflictVersion, ContentSnapshot, FieldConflict, ImplicitProvider,
  KeyRing, RowCache, RowKey, StructuralConflict, SyncState,
} from '../types.js';
import { NEW_PASSWORD, OLD_PASSWORD } from './core-e2e-fixtures.js';
import { advance, converge, olderApp, rawShared, setupWorld, teardownWorld, type World } from './sim-world.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface FileInput { keyHex: string; password: string }
interface MergeInput { w: string; s: string; nowMs: number; observedMtimeMs: number; deviceUuid: string; dev: number; incarnation: string }
interface Inputs { files: Record<string, FileInput>; merges: MergeInput[] }
interface FixtureDoc { format: 1; name: string; description: string; inputs: Inputs; outputs: Json }

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__', 'fixtures');
const MODE = process.env.UPDATE_SYNC_FIXTURES;
const PAGE_SIZE = 512;
const SECRET_COLUMNS = new Set(['password_encrypted', 'private_key_encrypted', 'totp_secret_encrypted']);
const GENERATE_TIMEOUT_MS = 120_000;
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-xp-fixtures-'));
  temps.push(dir);
  return dir;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const sha256 = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex');
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedObject = <T>(m: ReadonlyMap<string, T>, f: (v: T) => Json): Json =>
  Object.fromEntries([...m.keys()].sort(byKey).map((k) => [k, f(m.get(k) as T)]));
const rowKeys = (rows: readonly RowKey[]): Json => [...rows].sort((a, b) => byKey(rowKeyStr(a), rowKeyStr(b))).map((r) => [r.tbl, r.rowId]);

/** A private copy of committed bytes (never open the committed file itself). */
function openCopy(bytes: Buffer, readonly: boolean): Database.Database {
  const file = path.join(tempDir(), 'copy.conduit');
  fs.writeFileSync(file, bytes);
  const db = new Database(file, { readonly });
  if (!readonly) db.pragma('foreign_keys = ON');
  return db;
}

/** VACUUM INTO, then page_size 512 in rollback-journal mode: small, self-contained fixture bytes. */
function compactInto(srcPath: string, dest: string): void {
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { force: true });
  const src = new Database(srcPath, { readonly: true });
  src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
  src.close();
  const t = new Database(tmp);
  t.pragma('journal_mode = DELETE');
  t.pragma(`page_size = ${PAGE_SIZE}`);
  t.exec('VACUUM');
  t.close();
  fs.renameSync(tmp, dest);
}

// ---------- JSON views ----------

function openWithRing(ct: Uint8Array, ring: KeyRing): string | null {
  for (const k of [ring.current, ...ring.byEpoch.values()]) {
    const plain = openSecret(ct, k.kEpoch);
    if (plain !== null) return plain.toString('utf8');
  }
  return null;
}

function cellJson(col: string, v: unknown, ring: KeyRing | null): Json {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) {
    const plain = ring !== null && SECRET_COLUMNS.has(col) ? openWithRing(v, ring) : null;
    return plain === null ? { hex: hex(v) } : { plain };
  }
  return typeof v === 'bigint' ? Number(v) : (v as Json);
}

/** Every content row (all columns, sorted by id) and vault_meta; secrets as plaintext when a ring is given. */
function contentJson(c: ContentSnapshot, ring: KeyRing | null): Json {
  const table = (rows: ReadonlyMap<string, object>): Json =>
    [...rows.keys()].sort(byKey).map((id) =>
      Object.fromEntries(Object.entries(rows.get(id) as Record<string, unknown>).map(([k, v]) => [k, cellJson(k, v, ring)])),
    );
  return { entries: table(c.entries), folders: table(c.folders), history: table(c.history), meta: sortedObject(c.meta, (v) => v) };
}

/**
 * Re-encryption to another epoch draws fresh nonces, and merge keeps the smaller ciphertext of
 * one identity, so after an s-older alignment which rows get rewritten (and their updated_at)
 * depends on random bytes. Merge outputs therefore list updated_at and changedRows separately,
 * only for same-epoch merges.
 */
function withoutUpdatedAt(c: ContentSnapshot): ContentSnapshot {
  const strip = <R extends object>(rows: ReadonlyMap<string, R>): Map<string, R> =>
    new Map([...rows].map(([id, row]) => [id, Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'updated_at')) as R]));
  return { ...c, entries: strip(c.entries), folders: strip(c.folders) };
}

function updatedAtJson(c: ContentSnapshot): Json {
  const pick = (rows: ReadonlyMap<string, { readonly updated_at: unknown }>): Json =>
    sortedObject(rows, (r) => (typeof r.updated_at === 'string' ? r.updated_at : null));
  return { entries: pick(c.entries), folders: pick(c.folders) };
}

const cacheJson = (cache: RowCache): Json => sortedObject(cache, (e) => [e.materialized, e.rawHash]);

function versionJson(v: ConflictVersion): Json {
  const s = v.source;
  const source: Json =
    s.kind === 'device' ? { kind: s.kind, deviceUuid: s.deviceUuid, deviceName: s.deviceName } : s.kind === 'candidate' ? { kind: s.kind, label: s.label } : { kind: s.kind };
  return {
    id: v.id, dev: v.dev, ms: v.ms, c: v.c, lt: v.lt, pseudo: v.pseudo, source, timeMs: v.timeMs, value: encodeValue(v.value) as Json,
    masked: v.masked, vhash: v.vhash, provisional: v.provisional, undecryptable: v.undecryptable, redacted: v.redacted,
  };
}

function fieldJson(f: FieldConflict): Json {
  return {
    key: [f.key.tbl, f.key.rowId, f.key.reg], label: f.label, cls: f.cls, secret: f.secret, versions: f.versions.map(versionJson),
    staleRevert: f.staleRevert, keepBothOffered: f.keepBothOffered, invariantGuard: f.invariantGuard, snoozeKey: f.snoozeKey,
  };
}

function itemJson(item: ConflictItem): Json {
  switch (item.kind) {
    case 'field':
    case 'undecryptable':
      return { kind: item.kind, field: fieldJson(item.field) };
    case 'appearance':
      return { kind: item.kind, row: [item.row.tbl, item.row.rowId], fields: item.fields.map(fieldJson), newest: sortedObject(item.newest, (v) => v), snoozeKey: item.snoozeKey };
    case 'edit-delete':
      return { kind: item.kind, row: [item.row.tbl, item.row.rowId], deleted: item.deleted.map(versionJson), edited: item.edited.map(versionJson), snoozeKey: item.snoozeKey };
    case 'folder-delete':
      return { kind: item.kind, folder: [item.folder.tbl, item.folder.rowId], deleted: item.deleted.map(versionJson), changedItems: item.changedItems.map((r) => [r.tbl, r.rowId]), snoozeKey: item.snoozeKey };
    case 'cycle':
      return { kind: item.kind, tbl: item.tbl, rowIds: [...item.rowIds], movedToRoot: item.movedToRoot };
    case 'epoch':
      return { kind: item.kind, versions: item.versions.map(versionJson) };
  }
}

function conflictsJson(state: SyncState, implicit: ImplicitProvider, structural: readonly StructuralConflict[], ring: KeyRing): Json {
  const groups: ConflictGroup[] = listConflicts(state, {
    implicit, structural, snoozed: new Set(), candidateLabels: new Map(), repairedKeys: new Set(), keys: ring,
  });
  return groups.map((g) => ({ row: [g.row.tbl, g.row.rowId], title: g.title, snoozed: g.snoozed, items: g.items.map(itemJson) }));
}

const structuralJson = (s: readonly StructuralConflict[]): Json => s.map((c) => ({ kind: c.kind, tbl: c.tbl, rowIds: [...c.rowIds], movedToRoot: c.movedToRoot }));

function captureJson(c: CaptureResult): Json {
  return {
    changed: c.changed, contentRepairNeeded: c.contentRepairNeeded, stats: { ...c.stats }, changedRows: rowKeys(c.changedRows),
    notices: [...c.notices].map((n) => ({ id: n.id, kind: n.kind, count: n.count })).sort((a, b) => byKey(a.id, b.id)),
    held: [...c.held].map((h) => ({ key: [h.key.tbl, h.key.rowId, h.key.reg], kind: h.kind })),
  };
}

function alignJson(a: AlignResult): Json {
  switch (a.kind) {
    case 'proceed':
      return { kind: a.kind, relation: a.relation };
    case 'pause-newer':
      return { kind: a.kind, sEpochId: a.sEpochId, changedByDeviceUuid: a.changedByDeviceUuid, changedMs: a.changedMs };
    case 'concurrent':
      return { kind: a.kind, epochIds: [...a.epochIds] };
    case 'legacy-change':
      return { kind: a.kind };
  }
}

// ---------- Expectations ----------

function ringFor(state: SyncState, keyHex: string): { ring: KeyRing; implicit: ImplicitProvider } {
  const ring = buildKeyRing(state, deriveEpochKeys(Buffer.from(keyHex, 'hex'), state.lineageId), state.lineageId);
  return { ring, implicit: makeImplicitProvider(ring.current.kSync) };
}

function materializeOver(state: SyncState, content: ContentSnapshot, cache: RowCache, implicit: ImplicitProvider) {
  const epochId = currentEpochId(state);
  return materialize(state, content, cache, { implicit, currentEpoch: epochId === null ? null : state.epochs.get(epochId) ?? null });
}

function loadJson(db: Database.Database, input: FileInput): Json {
  const f = loadFile(db);
  const { ring, implicit } = ringFor(f.state, input.keyHex);
  const m = materializeOver(f.state, f.content, f.cache, implicit);
  const plan = m.plan;
  const planEmpty = [plan.upsertFolders, plan.upsertEntries, plan.upsertHistory, plan.deleteHistory, plan.deleteEntries, plan.deleteFolders].every((x) => x.length === 0) && plan.meta.size === 0;
  return {
    lineageId: f.state.lineageId, genesisId: f.state.genesisId, createdMs: f.state.createdMs, fileId: f.fileId,
    currentEpochId: currentEpochId(f.state), ringEpochs: [...ring.byEpoch.keys()].sort(byKey), digest: digestState(f.state),
    canonicalDump: canonicalDump(f.state), cache: cacheJson(f.cache), planEmpty, structural: structuralJson(m.structural),
    conflicts: conflictsJson(f.state, implicit, m.structural, ring),
  };
}

function genesisJson(bytes: Buffer, content: ContentSnapshot, input: FileInput): Json {
  const salt = content.meta.get('salt') ?? '';
  const lineageId = lineageIdFromSalt(salt);
  const k0 = deriveEpochKeys(Buffer.from(input.keyHex, 'hex'), lineageId);
  const g = genesisFromContent({ content, genesisId: genesisIdOf(bytes), lineageId, k0, randomBytes: crypto.randomBytes, now: () => 0 });
  const ring = buildKeyRing(g.state, k0, lineageId);
  const implicit = makeImplicitProvider(k0.kSync);
  return {
    lineageId, genesisId: g.state.genesisId, epochId: k0.epochId, undecryptable: g.undecryptable, digest: digestState(g.state),
    canonicalDump: canonicalDump(g.state), cache: cacheJson(g.cache), conflicts: conflictsJson(g.state, implicit, [], ring),
  };
}

function fileJson(dir: string, name: string, input: FileInput): Json {
  const bytes = fs.readFileSync(path.join(dir, name));
  const db = openCopy(bytes, true);
  try {
    const synced = hasSyncTables(db);
    const content = loadContent(db);
    const base = { sha256: sha256(bytes), syncFormat: readSyncFormat(db), hasSyncTables: synced, content: contentJson(content, null) };
    return synced ? { ...base, load: loadJson(db, input) } : { ...base, genesis: genesisJson(bytes, content, input) };
  } finally {
    db.close();
  }
}

/** One sync cycle of W against S (SimDevice.sync without transport), then materialize and save into a copy of W. */
function mergeJson(dir: string, inputs: Inputs, spec: MergeInput): Json {
  const sBytes = fs.readFileSync(path.join(dir, spec.s));
  const wDb = openCopy(fs.readFileSync(path.join(dir, spec.w)), false);
  const sDb = openCopy(sBytes, true);
  try {
    const W = loadFile(wDb);
    const S = loadFile(sDb);
    const { ring, implicit } = ringFor(W.state, inputs.files[spec.w].keyHex);
    const ctx = { deviceUuid: spec.deviceUuid, lineageId: W.state.lineageId, dev: spec.dev, incarnation: spec.incarnation, keys: ring, now: () => spec.nowMs, randomBytes: crypto.randomBytes };
    const dot = { dev: spec.dev, ms: spec.nowMs, c: 0 };
    const cW = captureFullPass({ state: W.state, content: W.content, cache: W.cache, implicit }, { kind: 'local', dot, interactive: false }, ctx);
    const sMeta = { salt: S.content.meta.get('salt') ?? null, verification: S.content.meta.get('verification') ?? null };
    const sEpoch = currentEpochId(S.state);
    const absorbKeys = sEpoch === null ? undefined : ring.byEpoch.get(sEpoch);
    const base = { w: spec.w, s: spec.s, wCaptureChanged: cW.changed };
    if (absorbKeys === undefined) return { ...base, align: alignJson(alignEpoch(S.state, sMeta, cW.state, ring)) };
    const att = { kind: 'legacy', observedMtimeMs: spec.observedMtimeMs, sideFilesPresent: false, serverSideFilesFlagRecent: false, absorbKeys, sourceSha256: sha256(sBytes), recover: recoveryFrom(cW.state) } as const;
    const s1 = captureLegacy({ state: S.state, content: S.content, cache: S.cache, implicit: makeImplicitProvider(absorbKeys.kSync) }, att, ctx);
    const aligned = alignEpoch(s1.state, sMeta, cW.state, ring);
    const absorbed = { ...base, capture: captureJson(s1), s1Digest: digestState(s1.state), align: alignJson(aligned) };
    if (aligned.kind !== 'proceed') return absorbed;
    const merged = merge(cW.state, aligned.state, implicit);
    const m = materializeOver(merged.state, W.content, W.cache, implicit);
    saveState(wDb, { state: m.state, plan: m.plan, cache: m.cache, baseline: W });
    const content = loadContent(wDb);
    return {
      ...absorbed, alignedDigest: digestState(aligned.state), invariantViolations: merged.report.invariantViolations.map((k) => [k.tbl, k.rowId, k.reg]),
      digest: digestState(m.state), canonicalDump: canonicalDump(m.state), upToDate: digestState(m.state) === digestState(aligned.state),
      reloadedDigest: digestState(loadFile(wDb).state), structural: structuralJson(m.structural),
      conflicts: conflictsJson(m.state, implicit, m.structural, ring), content: contentJson(withoutUpdatedAt(content), ring),
      ...(aligned.relation === 'same' ? { changedRows: rowKeys(m.changedRows), updatedAt: updatedAtJson(content) } : {}),
    };
  } finally {
    wDb.close();
    sDb.close();
  }
}

function computeOutputs(dir: string, inputs: Inputs): Json {
  const files = Object.fromEntries(Object.keys(inputs.files).sort(byKey).map((n) => [n, fileJson(dir, n, inputs.files[n])]));
  return { files, merges: inputs.merges.map((spec) => mergeJson(dir, inputs, spec)) };
}

// ---------- Generation (UPDATE_SYNC_FIXTURES=1) ----------

interface Built { readonly description: string; readonly inputs: Inputs }

const keyHexOf = (w: World, dev: 'a' | 'b'): string => hex(w[dev].keys.current.kEpoch);
const identity = (w: World, dev: 'a' | 'b') => ({ deviceUuid: w[dev].deviceUuid, dev: w[dev].dev, incarnation: w[dev].ctx.incarnation });

function publishInto(w: World, dev: 'a' | 'b', dest: string): void {
  const tmp = path.join(tempDir(), 'publish.conduit');
  w[dev].publish(tmp);
  compactInto(tmp, dest);
}

function withWorld(dir: string, build: (w: World) => Built): Built {
  fs.mkdirSync(dir, { recursive: true });
  const w = setupWorld();
  try {
    return build(w);
  } finally {
    teardownWorld(w);
  }
}

function buildPresync(dir: string): Built {
  return withWorld(dir, (w) => {
    const src = path.join(tempDir(), 'legacy.conduit');
    fs.writeFileSync(src, w.fixture.source.bytes);
    compactInto(src, path.join(dir, 'vault.conduit'));
    return {
      description: 'A pre-sync vault written by desktop 0.17 (ConduitVault): content only. Expect G1 genesis output.',
      inputs: { files: { 'vault.conduit': { keyHex: hex(w.fixture.source.key), password: OLD_PASSWORD } }, merges: [] },
    };
  });
}

function buildGenesis(dir: string): Built {
  return withWorld(dir, (w) => {
    publishInto(w, 'a', path.join(dir, 'vault.conduit'));
    return {
      description: 'The working copy of one device right after G1 genesis (sync tables, no app dots).',
      inputs: { files: { 'vault.conduit': { keyHex: keyHexOf(w, 'a'), password: OLD_PASSWORD } }, merges: [] },
    };
  });
}

function buildDivergent(dir: string): Built {
  return withWorld(dir, (w) => {
    const { a, b } = w;
    const { web, desk, db, servers, clients } = w.fixture.ids;
    converge(w);
    const steps: Array<() => void> = [
      () => a.edit((v) => v.updateEntry(web, { host: 'a.example', icon: 'server-a', tags: ['prod', 'db'] })),
      () => a.edit((v) => v.deleteEntry(desk), true),
      () => a.edit((v) => v.updateFolder(servers, { parent_id: clients })),
      () => a.edit((v) => void v.createEntry({ name: 'made on mac', entry_type: 'ssh', folder_id: clients, host: 'mac.local', password: 'pw-mac' })),
      () => b.edit((v) => v.updateEntry(web, { host: 'b.example', icon: 'server-b' })),
      () => b.edit((v) => v.updateEntry(desk, { notes: 'edited on pc' })),
      () => b.edit((v) => v.updateFolder(clients, { parent_id: servers })),
      () => b.edit((v) => v.deleteEntry(db), true),
      () => b.edit((v) => void v.createFolder({ name: 'Made on PC' })),
    ];
    for (const step of steps) {
      advance(w);
      step();
    }
    publishInto(w, 'a', path.join(dir, 'a.conduit'));
    publishInto(w, 'b', path.join(dir, 'b.conduit'));
    advance(w);
    const nowMs = w.now;
    return {
      description: 'Two converged devices, then divergent edits: same-field and appearance conflicts, edit versus delete, a folder cycle, a plain delete, new rows on both sides.',
      inputs: {
        files: { 'a.conduit': { keyHex: keyHexOf(w, 'a'), password: OLD_PASSWORD }, 'b.conduit': { keyHex: keyHexOf(w, 'b'), password: OLD_PASSWORD } },
        merges: [
          { w: 'a.conduit', s: 'b.conduit', nowMs, observedMtimeMs: nowMs - 1_000, ...identity(w, 'a') },
          { w: 'b.conduit', s: 'a.conduit', nowMs, observedMtimeMs: nowMs - 1_000, ...identity(w, 'b') },
        ],
      },
    };
  });
}

function buildEpoch(dir: string): Built {
  return withWorld(dir, (w) => {
    const { a, b } = w;
    const { web, db, desk, clients } = w.fixture.ids;
    converge(w);
    advance(w);
    b.edit((v) => v.updateEntry(web, { host: 'b-host' }));
    b.edit((v) => v.updateEntry(db, { password: 'pw-db-B' }));
    b.edit((v) => void v.createEntry({ name: 'made on pc', entry_type: 'ssh', folder_id: clients, password: 'pw-new' }));
    advance(w);
    a.changePassword(NEW_PASSWORD);
    advance(w);
    a.edit((v) => v.updateEntry(desk, { notes: 'after change', password: 'pw-desk-A' }));
    publishInto(w, 'a', path.join(dir, 'a.conduit'));
    publishInto(w, 'b', path.join(dir, 'b.conduit'));
    advance(w);
    const nowMs = w.now;
    return {
      description: 'A changed the master password (epoch E2, wrap to E1) while B held edits under E1. W=a absorbs S=b as s-older; W=b pauses (s-newer).',
      inputs: {
        files: { 'a.conduit': { keyHex: keyHexOf(w, 'a'), password: NEW_PASSWORD }, 'b.conduit': { keyHex: keyHexOf(w, 'b'), password: OLD_PASSWORD } },
        merges: [
          { w: 'a.conduit', s: 'b.conduit', nowMs, observedMtimeMs: nowMs - 1_000, ...identity(w, 'a') },
          { w: 'b.conduit', s: 'a.conduit', nowMs, observedMtimeMs: nowMs - 1_000, ...identity(w, 'b') },
        ],
      },
    };
  });
}

function buildLegacyEdit(dir: string): Built {
  return withWorld(dir, (w) => {
    const { web, desk } = w.fixture.ids;
    converge(w);
    advance(w);
    w.a.publish(w.shared);
    advance(w);
    olderApp(w, (v) => {
      v.updateEntry(web, { host: 'legacy-host' });
      v.deleteEntry(desk);
      v.createEntry({ name: 'made by 0.17', entry_type: 'web', host: 'old.example' });
    });
    rawShared(w, 'UPDATE entries SET config = ?, updated_at = ? WHERE id = ?', '{}', new Date(w.now).toISOString(), web);
    const observedMtimeMs = w.now;
    compactInto(w.shared, path.join(dir, 's.conduit'));
    publishInto(w, 'b', path.join(dir, 'w.conduit'));
    advance(w);
    return {
      description: 'An older desktop edited the published file in place (edit, delete, insert, rebuilt config). W=w.conduit absorbs it as legacy edits; the config rebuild is dropped.',
      inputs: {
        files: { 's.conduit': { keyHex: keyHexOf(w, 'a'), password: OLD_PASSWORD }, 'w.conduit': { keyHex: keyHexOf(w, 'b'), password: OLD_PASSWORD } },
        merges: [{ w: 'w.conduit', s: 's.conduit', nowMs: w.now, observedMtimeMs, ...identity(w, 'b') }],
      },
    };
  });
}

const BUILDERS: ReadonlyArray<readonly [string, (dir: string) => Built]> = [
  ['presync', buildPresync],
  ['genesis', buildGenesis],
  ['divergent', buildDivergent],
  ['epoch', buildEpoch],
  ['legacy-edit', buildLegacyEdit],
];

const docPath = (name: string): string => path.join(FIXTURES_DIR, name, 'expected.json');

function writeDoc(name: string, description: string, inputs: Inputs): void {
  const doc: FixtureDoc = { format: 1, name, description, inputs, outputs: computeOutputs(path.join(FIXTURES_DIR, name), inputs) };
  fs.writeFileSync(docPath(name), `${JSON.stringify(doc, null, 2)}\n`);
}

describe('cross-platform fixtures', () => {
  if (MODE === '1') {
    it.each(BUILDERS)('regenerates %s', (name, build) => {
      const dir = path.join(FIXTURES_DIR, name);
      fs.rmSync(dir, { recursive: true, force: true });
      const built = build(dir);
      writeDoc(name, built.description, built.inputs);
    }, GENERATE_TIMEOUT_MS);
  }

  if (MODE === 'expected') {
    it.each(BUILDERS)('recomputes expected.json of %s', (name) => {
      const doc = JSON.parse(fs.readFileSync(docPath(name), 'utf8')) as FixtureDoc;
      writeDoc(name, doc.description, doc.inputs);
    }, GENERATE_TIMEOUT_MS);
  }

  it.each(BUILDERS)('%s: expected.json equals what the core computes from the committed files', (name) => {
    const doc = JSON.parse(fs.readFileSync(docPath(name), 'utf8')) as FixtureDoc;
    expect(doc.format).toBe(1);
    expect(computeOutputs(path.join(FIXTURES_DIR, name), doc.inputs)).toEqual(doc.outputs);
  }, GENERATE_TIMEOUT_MS);
});
