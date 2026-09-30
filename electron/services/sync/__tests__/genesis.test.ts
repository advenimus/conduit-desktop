// @vitest-environment node
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decrypt } from '../../vault/crypto.js';
import { buildSyntheticFromRows } from '../candidates.js';
import { epochRegKey, metaRegKey, regKey, rowKey } from '../catalog.js';
import { canonicalDump, digestState } from '../digest.js';
import {
  adoptGenesis,
  baselineAbsorb,
  genesisFromContent,
  isGenesisLevel,
  newVaultState,
  stalenessFilter,
  type GenesisResult,
} from '../genesis.js';
import {
  baseRefOf,
  genesisIdOf,
  lineageIdFromSalt,
  makeImplicitProvider,
  pidOf,
  rawHash,
  vaultIdFor,
  vhashOfSecret,
  vhashOfValue,
  vhashUndecryptable,
  vrefPlain,
  vrefSecret,
} from '../hashing.js';
import { merge } from '../merge.js';
import { StateBuilder, getRegister, makeRegister, pmemOf, provisionalValue, registerPresence, rowKeyStr, rowLife } from '../state-view.js';
import { loadContent } from '../state-store.js';
import { SIB_UNDECRYPTABLE, SyncCoreError, TBL, type ContentSnapshot, type RegKey, type SyncState } from '../types.js';
import {
  DAY,
  GENESIS_ID,
  K0,
  KEY0,
  K_OLD,
  LINEAGE,
  OLD_KEY,
  OTHER_GENESIS_ID,
  SALT,
  STRANGER_KEY,
  T0,
  counterRandom,
  entry,
  folder,
  history,
  iso,
  makeCtx,
  ring,
  seal,
  snapshot,
  tempDir,
  verificationToken,
  writeLegacyVault,
  type TempDir,
} from './genesis-fixtures.js';

const implicit = makeImplicitProvider(K0.kSync);
const E = TBL.entries;

function legacyContent(): ContentSnapshot {
  return snapshot({
    folders: [folder('f1', { name: 'Servers', updated_at: iso(T0 + DAY) }), folder('f2', { name: '' })],
    entries: [
      entry('e1', {
        name: 'Web',
        host: 'web.local',
        port: 22,
        folder_id: 'f1',
        username: 'root',
        password_encrypted: seal('pw-1', KEY0),
        config: '{"b":2,"a":[1]}',
        tags: '["prod","eu"]',
        updated_at: iso(T0 + 2 * DAY),
      }),
      entry('e2', { name: 'Cred', entry_type: 'credential', password_encrypted: seal('pw-2', OLD_KEY), notes: '', host: '' }),
      entry('e3', { name: 'Lost', private_key_encrypted: seal('key', STRANGER_KEY) }),
    ],
    history: [history('h1', 'e1', { password_encrypted: seal('pw-0', KEY0), changed_at: iso(T0 + DAY / 2) })],
  });
}

function runGenesis(content: ContentSnapshot, genesisId = GENESIS_ID, seed = 'g'): GenesisResult {
  return genesisFromContent({ content, genesisId, lineageId: LINEAGE, k0: K0, ring: ring(K0, K_OLD), randomBytes: counterRandom(seed) });
}

const onlySib = (state: SyncState, key: RegKey) => {
  const reg = getRegister(state, key);
  expect(reg?.sibs).toHaveLength(1);
  return reg!.sibs[0];
};

/** An app edit that replaces every sibling of one register (interactive), for hand-built W states. */
function appEdit(state: SyncState, key: RegKey, value: string, dev: number, ms: number): SyncState {
  const b = new StateBuilder(state);
  const sib = { dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null };
  b.setRegister(makeRegister(key, [sib], pmemOf(state, key)));
  b.joinVv(dev, { ms, c: 0 });
  b.addDev({ dev, deviceUuid: `device-${dev}`, startedMs: ms });
  return b.build();
}

describe('G1 genesisFromContent', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it('two devices migrating the same bytes produce identical states', () => {
    const bytes = fs.readFileSync(writeLegacyVault(path.join(tmp.dir, 'Vault.conduit'), legacyContent()));
    const onDevice = (name: string, seed: string): GenesisResult => {
      const file = path.join(tmp.dir, name);
      fs.writeFileSync(file, bytes);
      const db = new Database(file, { readonly: true });
      try {
        const content = loadContent(db);
        const lineageId = lineageIdFromSalt(content.meta.get('salt') ?? '');
        return genesisFromContent({
          content,
          genesisId: genesisIdOf(bytes),
          lineageId,
          k0: K0,
          ring: ring(K0, K_OLD),
          randomBytes: counterRandom(seed),
        });
      } finally {
        db.close();
      }
    };
    const a = onDevice('device-a.conduit', 'a');
    const b = onDevice('device-b.conduit', 'b');
    expect(a.state.lineageId).toBe(LINEAGE);
    expect(canonicalDump(a.state)).toBe(canonicalDump(b.state));
    expect(digestState(a.state)).toBe(digestState(b.state));
    expect([...a.cache.entries()]).toEqual([...b.cache.entries()]);
    expect(a.state.rows.size).toBe(8);
  });

  it('writes genesis pseudo siblings for non-default registers only', () => {
    const { state } = runGenesis(legacyContent());
    const hostKey = regKey(E, 'e1', 'host');
    const host = onlySib(state, hostKey);
    expect(host).toMatchObject({ dev: 0, ms: 0, c: 0, lt: T0 + 2 * DAY, value: 'web.local', flags: 0, prevVhash: null });
    expect(host.vhash).toBe(vhashOfValue(hostKey, 'web.local'));
    expect(host.pid).toBe(pidOf(hostKey, vrefPlain(hostKey, 'web.local'), baseRefOf(null), K0.kPid));
    expect(getRegister(state, hostKey)?.pmem).toEqual({ ms: 0, ids: [host.pid] });

    for (const reg of ['_life', 'sort_order', 'is_favorite', 'domain']) {
      expect(registerPresence(state, regKey(E, 'e1', reg))).toBe('implicit');
    }
    expect(registerPresence(state, regKey(E, 'e2', 'host'))).toBe('implicit');
    expect(registerPresence(state, regKey(E, 'e2', 'notes'))).toBe('implicit');
    expect(rowLife(state, rowKey(E, 'e1'))).toBe('live');

    expect(provisionalValue(state, regKey(E, 'e1', 'container'), 'r')).toBe('f:f1');
    expect(provisionalValue(state, regKey(E, 'e1', 'port'), null)).toBe(22);
    expect(provisionalValue(state, regKey(E, 'e1', 'config.a'), null)).toBe('[1]');
    expect(provisionalValue(state, regKey(E, 'e1', 'config.b'), null)).toBe('2');
    expect(provisionalValue(state, regKey(E, 'e1', 'tag:prod'), null)).toBe(1);
    expect(onlySib(state, regKey(TBL.folders, 'f1', 'name')).lt).toBe(T0 + DAY);
    expect(onlySib(state, regKey(TBL.history, 'h1', 'entry_id')).lt).toBe(T0 + DAY / 2);
  });

  it('keeps rows whose registers are all defaults as known rows', () => {
    const { state } = runGenesis(legacyContent());
    const f2 = state.rows.get(rowKeyStr(rowKey(TBL.folders, 'f2')));
    expect([...(f2?.regs.keys() ?? [])]).toEqual(['created_at']);
    expect(registerPresence(state, regKey(TBL.folders, 'f2', 'name'))).toBe('implicit');

    const bare = runGenesis(snapshot({ folders: [folder('f9', { name: '', created_at: null })] })).state;
    expect(bare.rows.get(rowKeyStr(rowKey(TBL.folders, 'f9')))?.regs.size).toBe(0);
    expect(rowLife(bare, rowKey(TBL.folders, 'f9'))).toBe('live');
  });

  it('reads secrets with E0, re-encrypts stale-key secrets, and keeps unreadable ones undecryptable', () => {
    const content = legacyContent();
    const g = runGenesis(content);
    const pwKey = regKey(E, 'e1', 'password');
    const stored = content.entries.get('e1')?.password_encrypted as Buffer;
    const pw = onlySib(g.state, pwKey);
    expect(Buffer.from(pw.value as Uint8Array)).toEqual(stored);
    expect(pw.vhash).toBe(vhashOfSecret(pwKey, 'pw-1', K0.kSync));
    expect(pw.pid).toBe(pidOf(pwKey, vrefSecret(stored), baseRefOf(null), K0.kPid));

    const staleKey = regKey(E, 'e2', 'password');
    const staleStored = content.entries.get('e2')?.password_encrypted as Buffer;
    const stale = onlySib(g.state, staleKey);
    expect(decrypt(Buffer.from(stale.value as Uint8Array), KEY0).toString('utf8')).toBe('pw-2');
    expect(stale.vhash).toBe(vhashOfSecret(staleKey, 'pw-2', K0.kSync));
    expect(stale.pid).toBe(pidOf(staleKey, vrefSecret(staleStored), baseRefOf(null), K0.kPid));

    const lostStored = content.entries.get('e3')?.private_key_encrypted as Buffer;
    const lost = onlySib(g.state, regKey(E, 'e3', 'private_key'));
    expect(lost.flags & SIB_UNDECRYPTABLE).toBe(SIB_UNDECRYPTABLE);
    expect(lost.vhash).toBe(vhashUndecryptable(lostStored));
    expect(Buffer.from(lost.value as Uint8Array)).toEqual(lostStored);
    expect(g.undecryptable).toBe(1);
    expect(g.notices).toEqual([expect.objectContaining({ kind: 'undecryptable-secrets', count: 1 })]);
  });

  it('adds vault_meta, the E0 epoch record and the epoch register; vv and devs stay empty', () => {
    const content = legacyContent();
    const { state } = runGenesis(content);
    expect(provisionalValue(state, metaRegKey('vault_id'), null)).toBe(vaultIdFor(LINEAGE));
    expect(registerPresence(state, metaRegKey('cloud_sync_enabled'))).toBe('implicit');
    const epoch = onlySib(state, epochRegKey());
    expect(epoch).toMatchObject({ dev: 0, ms: 0, lt: 0, value: K0.epochId });
    expect(state.epochs.get(K0.epochId)).toEqual({
      epochId: K0.epochId,
      parent: null,
      salt: SALT,
      verification: content.meta.get('verification'),
      createdMs: 0,
    });
    expect(state).toMatchObject({ genesisId: GENESIS_ID, lineageId: LINEAGE, createdMs: 0 });
    expect(state.vv.size).toBe(0);
    expect(state.devs.size).toBe(0);

    const withId = runGenesis(snapshot({ meta: { vault_id: 'vault-1', cloud_sync_enabled: 'true' } })).state;
    expect(provisionalValue(withId, metaRegKey('vault_id'), null)).toBe('vault-1');
    expect(provisionalValue(withId, metaRegKey('cloud_sync_enabled'), null)).toBe('true');
  });

  it('builds a 5,000-entry genesis in reasonable time', () => {
    const entries = Array.from({ length: 5000 }, (_, i) =>
      entry(`p${i}`, { host: `host-${i}`, port: 22, username: `u${i}`, notes: `n${i}`, password_encrypted: seal(`pw${i}`, KEY0) }),
    );
    const t = performance.now();
    const g = runGenesis(snapshot({ entries }));
    const elapsed = performance.now() - t;
    expect(g.state.rows.size).toBe(5002);
    expect(elapsed).toBeLessThan(3000);
  });

  it('marks every content row materialized with its raw_hash', () => {
    const content = legacyContent();
    const { cache } = runGenesis(content);
    expect(cache.size).toBe(content.entries.size + content.folders.size + content.history.size);
    const e1 = content.entries.get('e1');
    expect(cache.get(rowKeyStr(rowKey(E, 'e1')))).toEqual({ materialized: true, rawHash: rawHash(E, e1!) });
  });
});

describe('newVaultState', () => {
  it('writes the epoch and vault_id registers as app siblings of one dot', () => {
    const dot = { dev: 42, ms: T0, c: 3 };
    const state = newVaultState({
      lineageId: 'lineage-new',
      genesisId: 'cd'.repeat(32),
      k0: K0,
      salt: SALT,
      verification: verificationToken(KEY0),
      createdMs: T0,
      dot,
      vaultId: 'vault-new',
      deviceUuid: 'device-new',
    });
    const epoch = onlySib(state, epochRegKey());
    expect(epoch).toMatchObject({ dev: 42, ms: T0, c: 3, pid: '', value: K0.epochId, prevVhash: null });
    expect(getRegister(state, epochRegKey())?.pmem).toBeNull();
    expect(onlySib(state, metaRegKey('vault_id')).value).toBe('vault-new');
    expect(state.vv.get(42)).toEqual({ ms: T0, c: 3 });
    expect(state.devs.get(42)).toEqual({ dev: 42, deviceUuid: 'device-new', startedMs: T0 });
    expect(state.epochs.get(K0.epochId)).toMatchObject({ parent: null, salt: SALT, createdMs: T0 });
    expect(() => newVaultState({ ...baseNewVault(), dot: { dev: 0, ms: 1, c: 0 } })).toThrow();
  });

  function baseNewVault() {
    return { lineageId: 'l', genesisId: 'g', k0: K0, salt: SALT, verification: 'v', createdMs: 1, vaultId: 'v' };
  }
});

// ---------- G2 ----------

function baselineContent(): ContentSnapshot {
  return snapshot({
    entries: [
      entry('e1', { host: 'a', created_at: iso(T0), updated_at: iso(T0 + 2 * DAY) }),
      entry('e2', { host: 'b', created_at: iso(T0 + DAY), updated_at: iso(T0 + 2 * DAY) }),
      entry('e3', { name: 'Late', created_at: iso(T0 + 9 * DAY), updated_at: iso(T0 + 9 * DAY) }),
      entry('e4', { host: 'g4', updated_at: iso(T0 + 3 * DAY) }),
    ],
    history: [history('h1', 'e1', { changed_at: iso(T0 + DAY) })],
  });
}

function presyncS(): ContentSnapshot {
  const g = baselineContent();
  return snapshot({
    entries: [
      entry('e1', { host: 'a2', created_at: iso(T0), updated_at: iso(T0 + 4 * DAY) }),
      entry('e4', { host: 'stale', updated_at: iso(T0 + DAY) }),
    ],
    history: [...g.history.values()],
    meta: { verification: g.meta.get('verification') ?? '' },
  });
}

describe('G2 staleness filter', () => {
  it('skips rows older than the baseline and allows deletes only when S is newer than the row', () => {
    const f = stalenessFilter(baselineContent(), presyncS());
    const s = presyncS();
    expect(f.skipRow?.(rowKey(E, 'e4'), s.entries.get('e4')!)).toBe(true);
    expect(f.skipRow?.(rowKey(E, 'e1'), s.entries.get('e1')!)).toBe(false);
    expect(f.skipRow?.(rowKey(E, 'new'), entry('new'))).toBe(false);
    expect(f.allowDelete?.(rowKey(E, 'e2'))).toBe(true);
    expect(f.allowDelete?.(rowKey(E, 'e3'))).toBe(false);
    expect(f.allowDelete?.(rowKey(TBL.history, 'h1'))).toBe(true);
    expect(f.allowDelete?.(rowKey(E, 'unknown'))).toBe(false);
    expect(f.allowDelete?.(rowKey(TBL.meta, 'meta'))).toBe(true);
  });
});

describe('G2 baselineAbsorb', () => {
  const input = (w: SyncState) => ({
    w,
    baseline: baselineContent(),
    s: presyncS(),
    sMtimeMs: T0 + 5 * DAY,
    sSha256: 'ff'.repeat(32),
    sKeys: K0,
    sideFilesPresent: false,
    serverSideFilesFlagRecent: false,
  });

  it('absorbs newer edits, ignores stale rows, and infers only allowed deletes', () => {
    const w = runGenesis(baselineContent()).state;
    const result = baselineAbsorb(input(w), makeCtx(ring(K0)));
    const s1 = result.state;
    expect(s1.genesisId).toBe(w.genesisId);
    const host = onlySib(s1, regKey(E, 'e1', 'host'));
    expect(host).toMatchObject({ dev: 0, value: 'a2', lt: T0 + 4 * DAY, ms: T0 + 4 * DAY });
    expect(rowLife(s1, rowKey(E, 'e2'))).toBe('dead');
    expect(rowLife(s1, rowKey(E, 'e3'))).toBe('live');
    expect(provisionalValue(s1, regKey(E, 'e4', 'host'), null)).toBe('g4');
    expect(getRegister(s1, regKey(E, 'e3', 'name'))).toEqual(getRegister(w, regKey(E, 'e3', 'name')));
  });

  it('merges into W without stray genesis siblings (the baseline genesis matches W)', () => {
    const w = runGenesis(baselineContent()).state;
    const s1 = baselineAbsorb(input(w), makeCtx(ring(K0))).state;
    const m = merge(w, s1, implicit).state;
    expect(provisionalValue(m, regKey(E, 'e1', 'host'), null)).toBe('a2');
    expect(getRegister(m, regKey(E, 'e3', 'name'))?.sibs).toHaveLength(1);
    expect(getRegister(m, regKey(E, 'e1', 'host'))?.sibs).toHaveLength(1);
    expect(rowLife(m, rowKey(E, 'e2'))).toBe('dead');
  });

  it('refuses a baseline under another key epoch than S', () => {
    const w = runGenesis(baselineContent()).state;
    const foreignBaseline = { ...baselineContent(), meta: new Map([['verification', verificationToken(STRANGER_KEY)]]) };
    const run = () => baselineAbsorb({ ...input(w), baseline: foreignBaseline }, makeCtx(ring(K0)));
    expect(run).toThrow(SyncCoreError);
    expect(run).toThrow(/different key epochs/);
  });
});

// ---------- G3 ----------

function versionA(): ContentSnapshot {
  return snapshot({
    entries: [
      entry('e1', { name: 'Shared', host: 'h1', updated_at: iso(T0 + DAY) }),
      entry('e2', { name: 'Only in W', updated_at: iso(T0 + 2 * DAY) }),
      entry('e4', { name: 'Same', host: 'same' }),
    ],
  });
}

function versionB(): ContentSnapshot {
  return snapshot({
    entries: [
      entry('e1', { name: 'Shared', host: 'h0', updated_at: iso(T0 + DAY / 2) }),
      entry('e3', { name: 'Only in S' }),
      entry('e4', { name: 'Same', host: 'same' }),
    ],
  });
}

describe('G3 isGenesisLevel', () => {
  it('is true for implicit and genesis-only registers, false for edits and unknown rows', () => {
    const w0 = runGenesis(versionA()).state;
    const w = appEdit(w0, regKey(E, 'e1', 'host'), 'h2', 5, T0 + 10 * DAY);
    expect(isGenesisLevel(w, regKey(E, 'e1', 'name'))).toBe(true);
    expect(isGenesisLevel(w, regKey(E, 'e1', 'port'))).toBe(true);
    expect(isGenesisLevel(w, regKey(E, 'e1', 'host'))).toBe(false);
    expect(isGenesisLevel(w, regKey(E, 'nope', 'host'))).toBe(false);
  });
});

describe('G3 adoptGenesis', () => {
  function adopt() {
    const w0 = runGenesis(versionA()).state;
    const w = appEdit(w0, regKey(E, 'e1', 'host'), 'h2', 5, T0 + 10 * DAY);
    const s1 = runGenesis(versionB(), OTHER_GENESIS_ID).state;
    return { w, s1, result: adoptGenesis(w, s1, implicit) };
  }

  it("takes the shared file's genesis and keeps W's edits", () => {
    const { s1, result } = adopt();
    const m = result.merged.state;
    expect(m.genesisId).toBe(OTHER_GENESIS_ID);
    expect(m.rows.has(rowKeyStr(rowKey(E, 'e2')))).toBe(false);
    expect(m.rows.has(rowKeyStr(rowKey(E, 'e3')))).toBe(true);
    expect(getRegister(m, regKey(E, 'e1', 'name'))).toEqual(getRegister(s1, regKey(E, 'e1', 'name')));
    expect(getRegister(m, regKey(E, 'e4', 'host'))).toEqual(getRegister(s1, regKey(E, 'e4', 'host')));
    const host = getRegister(m, regKey(E, 'e1', 'host'));
    expect(host?.sibs.map((s) => s.value).sort()).toEqual(['h0', 'h2']);
    expect(provisionalValue(m, regKey(E, 'e1', 'host'), null)).toBe('h2');
    expect(m.vv.get(5)).toEqual({ ms: T0 + 10 * DAY, c: 0 });
    expect(result.merged.report.invariantViolations).toEqual([]);
  });

  it("returns W's genesis-level values of live rows as leftovers", () => {
    const { result } = adopt();
    const lo = result.leftovers;
    expect([...lo.keys()].sort()).toEqual(['1:e1', '1:e2', '1:e4']);
    const e1 = lo.get('1:e1')!;
    expect(e1.rowTimeMs).toBe(T0 + DAY);
    expect(e1.values.get('name')?.value).toBe('Shared');
    expect(e1.values.has('host')).toBe(false);
    expect(e1.values.get('port')).toEqual({ value: null, vhash: implicit(regKey(E, 'e1', 'port')).vhash, flags: 0 });
    expect(lo.get('1:e2')?.values.get('name')?.value).toBe('Only in W');
    expect(lo.get('1:e2')?.rowTimeMs).toBe(T0 + 2 * DAY);
  });

  it('offers the leftovers as a stale-by-nature synthetic candidate against M', () => {
    const { result } = adopt();
    const m = result.merged.state;
    const opts = { source: 'genesis-leftovers', label: 'Differences between two copies', staleByNature: true } as const;
    const cand = buildSyntheticFromRows(m, versionB(), result.leftovers, opts, makeCtx(ring(K0)), implicit);
    expect([...cand.state.rows.keys()]).toEqual(['1:e2']);
    expect(cand.preview.onlyInCopy).toEqual([{ row: rowKey(E, 'e2'), title: 'Only in W' }]);
    expect(cand.preview.changedFields).toEqual([]);
    expect(cand.preview.missingFromCopy).toEqual([]);
    const merged = merge(m, cand.state, implicit).state;
    expect(provisionalValue(merged, regKey(E, 'e2', 'name'), null)).toBe('Only in W');
  });

  it('rejects another lineage', () => {
    const w = runGenesis(versionA()).state;
    const s1 = { ...runGenesis(versionB(), OTHER_GENESIS_ID).state, lineageId: 'other-lineage' };
    expect(() => adoptGenesis(w, s1, implicit)).toThrow(SyncCoreError);
  });

  it("keeps W's pre-sync fields of a row only W knows and edited since its genesis (S1 lacks the row)", () => {
    const w0 = runGenesis(versionA()).state;
    const w = appEdit(w0, regKey(E, 'e2', 'host'), 'w-host', 6, T0 + 11 * DAY);
    const s1 = runGenesis(versionB(), OTHER_GENESIS_ID).state;
    const m = adoptGenesis(w, s1, implicit).merged.state;
    expect(provisionalValue(m, regKey(E, 'e2', 'host'), null)).toBe('w-host');
    expect(getRegister(m, regKey(E, 'e2', 'name'))).toBe(getRegister(w, regKey(E, 'e2', 'name')));
    expect(provisionalValue(m, regKey(E, 'e2', 'name'), null)).toBe('Only in W');
    expect(registerPresence(m, regKey(E, 'e2', 'port'))).toBe('implicit');
  });
});
