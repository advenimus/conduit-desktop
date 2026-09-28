// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decrypt } from '../../vault/crypto.js';
import {
  absorbReplicaCandidate,
  applyCandidate,
  buildSyntheticCandidate,
  buildSyntheticFromRows,
  candidateRowsFromContent,
  classifyCandidate,
  deleteMissingWrites,
  type SyntheticOptions,
} from '../candidates.js';
import { IMPLICIT_PMEM, epochRegKey, regKey, rowKey } from '../catalog.js';
import { digestState } from '../digest.js';
import { genesisFromContent } from '../genesis.js';
import { deriveEpochKeys, deriveSyntheticDev, makeImplicitProvider, rawHash, vhashOfValue } from '../hashing.js';
import { createWrap, reencryptState } from '../key-epoch.js';
import { identityKey } from '../sibling.js';
import {
  StateBuilder,
  getRegister,
  makeRegister,
  pmemOf,
  provisionalValue,
  recoveryFrom,
  rowKeyStr,
  rowLife,
} from '../state-view.js';
import {
  SyncCoreError,
  TBL,
  type ContentSnapshot,
  type EntryRow,
  type LegacyAttribution,
  type LoadedFile,
  type RegKey,
  type SyncState,
} from '../types.js';
import {
  DAY,
  DEVICE_UUID,
  GENESIS_ID,
  K0,
  KEY0,
  K_OLD,
  LINEAGE,
  OLD_KEY,
  SALT,
  T0,
  counterRandom,
  entry,
  folder,
  iso,
  makeCtx,
  ring,
  seal,
  snapshot,
} from './genesis-fixtures.js';

const E = TBL.entries;
const implicit = makeImplicitProvider(K0.kSync);
const EDIT_DEV = 5;
const COPY: SyntheticOptions = { source: 'copy', label: 'Vault 2.conduit', staleByNature: false };
const SANDBOX: SyntheticOptions = { source: 'ios-sandbox', label: 'Changes found on this iPhone', staleByNature: true };

function baseContent(): ContentSnapshot {
  return snapshot({
    folders: [folder('f1', { name: 'Servers' })],
    entries: [
      entry('e1', { name: 'Web', host: 'h', updated_at: iso(T0 + DAY) }),
      entry('e2', { name: 'Kept' }),
      entry('e3', { name: 'Gone', host: 'old-host' }),
      entry('e5', { name: 'Pw', password_encrypted: seal('pw', KEY0) }),
    ],
    meta: { vault_id: 'vault-1' },
  });
}

function write(b: StateBuilder, state: SyncState, key: RegKey, value: string, dev: number, ms: number): void {
  const sib = { dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null };
  b.setRegister(makeRegister(key, [sib], pmemOf(state, key)));
  b.joinVv(dev, { ms, c: 0 });
  b.addDev({ dev, deviceUuid: `device-${dev}`, startedMs: ms });
}

/** M = genesis(base) + app edit of e1.host + app delete of e3 (with its grave). */
function buildM(): { genesis: ReturnType<typeof genesisFromContent>; m: SyncState; mContent: ContentSnapshot } {
  const genesis = genesisFromContent({ content: baseContent(), genesisId: GENESIS_ID, lineageId: LINEAGE, k0: K0 });
  const g = genesis.state;
  const b = new StateBuilder(g);
  write(b, g, regKey(E, 'e1', 'host'), 'h-app', EDIT_DEV, T0 + 10 * DAY);
  write(b, g, regKey(E, 'e3', '_life'), 'dead', EDIT_DEV, T0 + 11 * DAY);
  b.setGrave(rowKey(E, 'e3'), { diedMs: T0 + 11 * DAY, diedC: 0, diedDev: EDIT_DEV, redacted: false });
  const m = b.build();
  const base = baseContent();
  const mContent: ContentSnapshot = {
    ...base,
    entries: new Map([...base.entries].filter(([id]) => id !== 'e3').map(([id, r]) => [id, id === 'e1' ? { ...r, host: 'h-app', updated_at: iso(T0 + 10 * DAY) } : r])),
  };
  return { genesis, m, mContent };
}

function copyContent(): ContentSnapshot {
  return snapshot({
    folders: [folder('f1', { name: 'Servers' })],
    entries: [
      entry('e1', { name: 'Web', host: 'h-copy', updated_at: iso(T0 + 12 * DAY) }),
      entry('e3', { name: 'Gone', host: 'copy-host', updated_at: iso(T0 + 12 * DAY) }),
      entry('e4', { name: 'New', host: 'n' }),
      entry('e5', { name: 'Pw', password_encrypted: seal('pw', KEY0) }),
    ],
  });
}

const firstDev = (seed = 'r'): number => deriveSyntheticDev(DEVICE_UUID, counterRandom(seed)(16));

describe('classifyCandidate', () => {
  it('is a replica only with sync tables, the same lineage and the same genesis', () => {
    const { m } = buildM();
    const info = { hasSyncTables: true, lineageId: LINEAGE, genesisId: GENESIS_ID };
    expect(classifyCandidate(info, m)).toBe('replica');
    expect(classifyCandidate({ ...info, hasSyncTables: false }, m)).toBe('synthetic');
    expect(classifyCandidate({ ...info, genesisId: 'other' }, m)).toBe('synthetic');
    expect(classifyCandidate({ ...info, lineageId: null }, m)).toBe('synthetic');
  });
});

describe('synthetic candidates', () => {
  it('mints differences as siblings of a fresh dev at (dev_syn, 0, 0) and never mints deletes', () => {
    const { m, mContent } = buildM();
    const ctx = makeCtx(ring(K0));
    const cand = buildSyntheticCandidate(m, mContent, copyContent(), COPY, ctx, implicit);
    const dev = firstDev();
    expect(cand.dev).toBe(dev);
    expect(cand.dot).toEqual({ dev, ms: 0, c: 0 });
    expect(cand.state.vv.get(dev)).toEqual({ ms: 0, c: 0 });
    expect(cand.state.vv.get(EDIT_DEV)).toEqual(m.vv.get(EDIT_DEV));
    expect(cand.state.devs.get(dev)).toEqual({ dev, deviceUuid: DEVICE_UUID, startedMs: ctx.now() });
    expect([...cand.state.rows.keys()].sort()).toEqual(['1:e1', '1:e3', '1:e4']);

    const hostKey = regKey(E, 'e1', 'host');
    const host = getRegister(cand.state, hostKey)!;
    const minted = host.sibs.find((s) => s.dev === dev)!;
    expect(minted).toMatchObject({ ms: 0, c: 0, value: 'h-copy', lt: T0 + 12 * DAY, prevVhash: null, pid: '' });
    expect(host.sibs.filter((s) => s.dev !== dev)).toEqual(getRegister(m, hostKey)!.sibs);
    expect(host.pmem).toEqual(getRegister(m, hostKey)!.pmem);

    for (const row of cand.state.rows.values()) {
      const life = row.regs.get('_life');
      for (const s of life?.sibs ?? []) if (s.dev === dev) expect(s.value).toBe('live');
    }
    const e3 = cand.state.rows.get('1:e3')!;
    expect(e3.grave).toEqual(m.rows.get('1:e3')!.grave);
    expect(e3.regs.get('_life')!.sibs.map((s) => s.value).sort()).toEqual(['dead', 'live']);

    const e4 = cand.state.rows.get('1:e4')!;
    expect([...e4.regs.keys()].sort()).toEqual(['_life', 'created_at', 'entry_type', 'host', 'name']);
    expect(e4.regs.get('_life')!.pmem).toBeNull();
  });

  it('builds the preview: changed fields, items only in the copy, items missing from it', () => {
    const { m, mContent } = buildM();
    const { preview } = buildSyntheticCandidate(m, mContent, copyContent(), COPY, makeCtx(ring(K0)), implicit);
    expect(preview).toMatchObject({ kind: 'synthetic', source: 'copy', label: 'Vault 2.conduit', needsReview: true, deletions: [] });
    expect(preview.changedFields).toEqual([
      expect.objectContaining({ key: regKey(E, 'e1', 'host'), current: 'h-app', incoming: 'h-copy', masked: false, rowTitle: 'Web' }),
    ]);
    expect(preview.onlyInCopy.map((r) => r.row.rowId).sort()).toEqual(['e3', 'e4']);
    expect(preview.onlyInCopy.find((r) => r.row.rowId === 'e4')?.title).toBe('New');
    expect(preview.missingFromCopy).toEqual([{ row: rowKey(E, 'e2'), title: 'Kept' }]);
  });

  it('merging it keeps M provisional and turns every difference into a conflict', () => {
    const { m, mContent } = buildM();
    const cand = buildSyntheticCandidate(m, mContent, copyContent(), COPY, makeCtx(ring(K0)), implicit);
    const merged = applyCandidate(m, cand.state, implicit).state;
    const host = getRegister(merged, regKey(E, 'e1', 'host'))!;
    expect(host.sibs.map((s) => s.value).sort()).toEqual(['h-app', 'h-copy']);
    expect(provisionalValue(merged, regKey(E, 'e1', 'host'), null)).toBe('h-app');
    expect(rowLife(merged, rowKey(E, 'e3'))).toBe('live');
    expect(getRegister(merged, regKey(E, 'e3', '_life'))!.sibs.map((s) => s.value).sort()).toEqual(['dead', 'live']);
    expect(provisionalValue(merged, regKey(E, 'e4', 'name'), null)).toBe('New');
    expect(rowLife(merged, rowKey(E, 'e2'))).toBe('live');
    expect(merged.rows.get('1:e2')).toBe(m.rows.get('1:e2'));
  });

  it('keeps the implicit sibling when minting over an implicit register', () => {
    const { m, mContent } = buildM();
    const content = snapshot({ entries: [entry('e2', { name: 'Kept', color: 'red', updated_at: iso(T0 + DAY) })] });
    const cand = buildSyntheticCandidate(m, mContent, content, COPY, makeCtx(ring(K0)), implicit);
    const colorKey = regKey(E, 'e2', 'color');
    const color = getRegister(cand.state, colorKey)!;
    expect(color.pmem).toBe(IMPLICIT_PMEM);
    expect(color.sibs.map((s) => identityKey(s))).toContain(identityKey(implicit(colorKey)));
    const merged = applyCandidate(m, cand.state, implicit).state;
    expect(getRegister(merged, colorKey)!.sibs.map((s) => s.value).sort()).toEqual([null, 'red'].sort());
  });

  it('uses a fresh dev for every import', () => {
    const { m, mContent } = buildM();
    const a = buildSyntheticCandidate(m, mContent, copyContent(), COPY, makeCtx(ring(K0), { randomBytes: counterRandom('a') }), implicit);
    const b = buildSyntheticCandidate(m, mContent, copyContent(), COPY, makeCtx(ring(K0), { randomBytes: counterRandom('b') }), implicit);
    expect(a.dev).not.toBe(b.dev);
  });

  it('stale-by-nature candidates count only rows newer than M (absent rows always count)', () => {
    const { m, mContent } = buildM();
    const stale = snapshot({
      entries: [
        entry('e1', { name: 'Web', host: 'h-stale', updated_at: iso(T0 + 2 * DAY) }),
        entry('e3', { name: 'Gone', host: 'stale-host', updated_at: iso(T0 + DAY) }),
        entry('e4', { name: 'New' }),
        entry('e2', { name: 'Kept', notes: 'newer', updated_at: iso(T0 + 3 * DAY) }),
      ],
    });
    const cand = buildSyntheticCandidate(m, mContent, stale, SANDBOX, makeCtx(ring(K0)), implicit);
    expect([...cand.state.rows.keys()].sort()).toEqual(['1:e2', '1:e4']);
    expect(cand.preview.changedFields.map((f) => f.key.reg)).toEqual(['notes']);
  });

  it('compares secrets by plaintext and re-encrypts stale-key secrets under the current key', () => {
    const { m, mContent } = buildM();
    const ctx = makeCtx(ring(K0, K_OLD));
    const same = buildSyntheticCandidate(m, mContent, snapshot({ entries: [entry('e5', { name: 'Pw', password_encrypted: seal('pw', OLD_KEY) })] }), COPY, ctx, implicit);
    expect(same.state.rows.size).toBe(0);

    const changed = buildSyntheticCandidate(m, mContent, snapshot({ entries: [entry('e5', { name: 'Pw', password_encrypted: seal('pw-new', OLD_KEY) })] }), COPY, ctx, implicit);
    const pwKey = regKey(E, 'e5', 'password');
    const minted = getRegister(changed.state, pwKey)!.sibs.find((s) => s.dev === changed.dev)!;
    expect(decrypt(Buffer.from(minted.value as Uint8Array), KEY0).toString('utf8')).toBe('pw-new');
    expect(changed.preview.changedFields).toEqual([expect.objectContaining({ key: pwKey, masked: true, current: null, incoming: null })]);
  });

  it('reads candidate rows with catalog values, vhashes and row times', () => {
    const rows = candidateRowsFromContent(copyContent(), makeCtx(ring(K0)));
    const e1 = rows.get('1:e1')!;
    expect(e1.rowTimeMs).toBe(T0 + 12 * DAY);
    expect(e1.values.get('host')).toEqual({ value: 'h-copy', vhash: vhashOfValue(regKey(E, 'e1', 'host'), 'h-copy'), flags: 0 });
    expect(e1.values.get('_life')?.value).toBe('live');
    expect(rows.has('4:meta')).toBe(false);
  });

  it('diffs 5,000 unchanged rows quickly', () => {
    const entries = Array.from({ length: 5000 }, (_, i) => entry(`p${i}`, { host: `host-${i}`, port: 22, username: `u${i}`, notes: `n${i}` }));
    const content = snapshot({ entries });
    const m = genesisFromContent({ content, genesisId: GENESIS_ID, lineageId: LINEAGE, k0: K0 }).state;
    const ctx = makeCtx(ring(K0));
    const rows = candidateRowsFromContent(content, ctx);
    const t = performance.now();
    const cand = buildSyntheticFromRows(m, content, rows, COPY, ctx, implicit);
    const elapsed = performance.now() - t;
    expect(cand.state.rows.size).toBe(0);
    expect(elapsed).toBeLessThan(900);
  });
});

// ---------- Replica candidates ----------

function legacyAtt(m: SyncState): LegacyAttribution {
  return {
    kind: 'legacy',
    observedMtimeMs: T0 + 30 * DAY,
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
    absorbKeys: K0,
    sourceSha256: 'ee'.repeat(32),
    recover: recoveryFrom(m),
  };
}

const META = { source: 'copy', label: 'Vault 2.conduit' } as const;

function replicaFile(state: SyncState, content: ContentSnapshot, cache: LoadedFile['cache']): LoadedFile {
  return { state, content, cache, fileId: null, syncFormat: 1 };
}

describe('replica candidates', () => {
  it('a stale replica contributes nothing and needs no review', () => {
    const { genesis, m } = buildM();
    const file = replicaFile(genesis.state, baseContent(), genesis.cache);
    const r = absorbReplicaCandidate(file, m, legacyAtt(m), META, makeCtx(ring(K0)), implicit);
    expect(r.capture.changed).toBe(false);
    expect(r.appDotsOnly).toBe(true);
    expect(r.preview).toMatchObject({ kind: 'replica', needsReview: false, changedFields: [], onlyInCopy: [], deletions: [] });
    expect(digestState(applyCandidate(m, r.state, implicit).state)).toBe(digestState(m));
  });

  it('a replica holding only app dots merges without review', () => {
    const { genesis, m } = buildM();
    const b = new StateBuilder(genesis.state);
    write(b, genesis.state, regKey(E, 'e2', 'name'), 'Renamed', 9, T0 + 20 * DAY);
    const state = b.build();
    const base = baseContent();
    const e2: EntryRow = { ...base.entries.get('e2')!, name: 'Renamed' };
    const content: ContentSnapshot = { ...base, entries: new Map([...base.entries, ['e2', e2]]) };
    const cache = new Map(genesis.cache).set('1:e2', { materialized: true, rawHash: rawHash(E, e2) });
    const r = absorbReplicaCandidate(replicaFile(state, content, cache), m, legacyAtt(m), META, makeCtx(ring(K0)), implicit);
    expect(r.appDotsOnly).toBe(true);
    expect(r.preview.needsReview).toBe(false);
    expect(r.preview.changedFields).toEqual([expect.objectContaining({ key: regKey(E, 'e2', 'name'), current: 'Kept', incoming: 'Renamed' })]);
  });

  it('a replica with legacy edits and deletes asks first', () => {
    const { genesis, m } = buildM();
    const base = baseContent();
    const entries = new Map([...base.entries].filter(([id]) => id !== 'e2'));
    entries.set('e5', { ...base.entries.get('e5')!, host: 'legacy-host', updated_at: iso(T0 + 25 * DAY) });
    const r = absorbReplicaCandidate(replicaFile(genesis.state, { ...base, entries }, genesis.cache), m, legacyAtt(m), META, makeCtx(ring(K0)), implicit);
    expect(r.capture.changed).toBe(true);
    expect(r.appDotsOnly).toBe(false);
    expect(r.preview.needsReview).toBe(true);
    expect(r.preview.deletions).toEqual([{ row: rowKey(E, 'e2'), title: 'Kept' }]);
    expect(r.preview.changedFields).toEqual([expect.objectContaining({ key: regKey(E, 'e5', 'host'), current: null, incoming: 'legacy-host' })]);
  });
});

describe('replica candidates under another key epoch', () => {
  const K1 = deriveEpochKeys(Buffer.alloc(32, 5), LINEAGE);

  it('aligns an older-epoch replica to M before previewing', () => {
    const { genesis, m: m0 } = buildM();
    const moved = reencryptState(m0, ring(K0), K1).state;
    const b = new StateBuilder(moved);
    b.setEpoch({ epochId: K1.epochId, parent: K0.epochId, salt: 'bmV3LXNhbHQ=', verification: 'bmV3', createdMs: T0 + 12 * DAY });
    b.addWrap(createWrap(K1, K0, counterRandom('wrap')));
    write(b, moved, epochRegKey(), K1.epochId, EDIT_DEV, T0 + 12 * DAY);
    const m = b.build();
    const ringM = ring(K1, K0);
    const implicitM = makeImplicitProvider(K1.kSync);
    const file = replicaFile(genesis.state, baseContent(), genesis.cache);
    const r = absorbReplicaCandidate(file, m, legacyAtt(m), META, makeCtx(ringM), implicitM);
    expect(r.state.rows.get('1:e5')?.regs.get('password')?.sibs[0].vhash).toBe(
      m.rows.get('1:e5')?.regs.get('password')?.sibs[0].vhash,
    );
    expect(r.appDotsOnly).toBe(true);
    expect(r.preview).toMatchObject({ needsReview: false, changedFields: [], onlyInCopy: [], deletions: [] });
    expect(digestState(applyCandidate(m, r.state, implicitM).state)).toBe(digestState(m));
  });

  it('refuses a newer-epoch replica until the key-epoch flow has run', () => {
    const { genesis, m } = buildM();
    const content = baseContent();
    const b = new StateBuilder(genesis.state);
    b.setEpoch({ epochId: K1.epochId, parent: K0.epochId, salt: SALT, verification: content.meta.get('verification') ?? '', createdMs: T0 + DAY });
    write(b, genesis.state, epochRegKey(), K1.epochId, 9, T0 + DAY);
    const file = replicaFile(b.build(), content, genesis.cache);
    const run = () => absorbReplicaCandidate(file, m, { ...legacyAtt(m), absorbKeys: K1 }, META, makeCtx(ring(K0)), implicit);
    expect(run).toThrow(SyncCoreError);
    expect(run).toThrow(/pause-newer/);
  });
});

describe('deleteMissingWrites', () => {
  it('writes interactive _life = dead only for rows M holds live', () => {
    const { m } = buildM();
    const writes = deleteMissingWrites(m, [rowKey(E, 'e2'), rowKey(E, 'e3'), rowKey(E, 'nope')], makeCtx(ring(K0)));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ key: regKey(E, 'e2', '_life'), value: 'dead', mode: 'replace-all' });
    expect(writes[0].vhash).toBe(vhashOfValue(regKey(E, 'e2', '_life'), 'dead'));
    expect(rowKeyStr(rowKey(E, 'e2'))).toBe('1:e2');
  });
});
