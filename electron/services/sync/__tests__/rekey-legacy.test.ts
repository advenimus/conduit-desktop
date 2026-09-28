// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encrypt } from '../../vault/crypto.js';
import { epochRegKey, regKey } from '../catalog.js';
import { genesisFromContent } from '../genesis.js';
import { vhashOfSecret, vhashOfValue } from '../hashing.js';
import { buildKeyRing, readSecret, unwrapValidated, VERIFICATION_PLAINTEXT } from '../key-epoch.js';
import { absorbLegacyPasswordChange, type LegacyPasswordChangeInput } from '../rekey.js';
import { StateBuilder, currentEpochId, getRegister, headOf, pmemOf } from '../state-view.js';
import { SIB_UNDECRYPTABLE, SyncCoreError, TBL, type ContentSnapshot, type EntryRow, type LoadedFile, type Sibling, type SyncState } from '../types.js';
import { GENESIS, LINEAGE, epochKeysFor, fakeDerive, ringOf, secretSib, seqRandom, testContext, withRegister } from './key-epoch-fixtures.js';

const rand = seqRandom(31);
const K1 = fakeDerive('pw1')('salt1');
const KL = fakeDerive('pw-new')('salt-new');
const E1 = epochKeysFor('pw1', 'salt1');
const EL = epochKeysFor('pw-new', 'salt-new');
const T0 = Date.UTC(2026, 5, 1);
const NOW = T0 + 10_000_000;
const MTIME = T0 + 5_000_000;
const pw = (id: string) => regKey(TBL.entries, id, 'password');
const HOST1 = regKey(TBL.entries, 'e1', 'host');

function seal(plain: string, key: Buffer): Buffer {
  return encrypt(Buffer.from(plain, 'utf8'), key);
}

function entryRow(id: string, over: Partial<EntryRow>): EntryRow {
  const iso = new Date(T0).toISOString();
  return {
    id, name: `Entry ${id}`, entry_type: 'ssh', folder_id: null, parent_entry_id: null, sort_order: 0,
    host: null, port: null, credential_id: null, username: null, password_encrypted: null, domain: null,
    private_key_encrypted: null, totp_secret_encrypted: null, icon: null, color: null, credential_type: null,
    config: '{}', tags: '[]', is_favorite: 0, notes: null, created_at: iso, updated_at: iso, ...over,
  };
}

function content(key: Buffer, salt: string, rows: EntryRow[]): ContentSnapshot {
  const verification = seal(VERIFICATION_PLAINTEXT, key).toString('base64');
  return {
    entries: new Map(rows.map((r) => [r.id, r])),
    folders: new Map(),
    history: new Map(),
    meta: new Map([['schema_version', '10'], ['salt', salt], ['verification', verification]]),
  };
}

const OLD = content(K1, 'salt1', [
  entryRow('e1', { host: 'h1', password_encrypted: seal('alpha', K1) }),
  entryRow('e2', { password_encrypted: seal('beta', K1) }),
  entryRow('e3', { password_encrypted: seal('gamma', K1) }),
]);
const later = new Date(T0 + 60_000).toISOString();
const NEW = content(KL, 'salt-new', [
  entryRow('e1', { host: 'h2', updated_at: later, password_encrypted: seal('alpha', KL) }),
  entryRow('e2', { updated_at: later, password_encrypted: seal('beta', KL) }),
  entryRow('e3', { updated_at: later, password_encrypted: seal('gamma2', KL) }),
]);

const genesis = genesisFromContent({ content: OLD, genesisId: GENESIS, lineageId: LINEAGE, k0: E1 });

/** What state-store hands back: head values come from the (changed) content columns. */
function loadedHeads(state: SyncState, c: ContentSnapshot): SyncState {
  const b = new StateBuilder(state);
  for (const row of c.entries.values()) {
    for (const [reg, value] of [['password', row.password_encrypted], ['host', row.host]] as const) {
      const cur = getRegister(state, regKey(TBL.entries, row.id, reg));
      const head = cur ? headOf(reg, cur.sibs) : null;
      if (!cur || !head) continue;
      b.setRegister({ ...cur, sibs: cur.sibs.map((s) => (s === head ? { ...s, value: value as Uint8Array | string | null } : s)) });
    }
  }
  return b.build();
}

const S_FILE: LoadedFile = {
  state: loadedHeads(genesis.state, NEW),
  content: NEW,
  cache: genesis.cache,
  fileId: null,
  syncFormat: 1,
};

/** W = the same genesis plus an unpublished local edit of e2's password. */
const W = withRegister(genesis.state, pw('e2'), [secretSib(pw('e2'), 'beta-local', E1, rand, 3, 60_000)], getRegister(genesis.state, pw('e2'))?.pmem ?? null);

function absorb(oldRing: LegacyPasswordChangeInput['oldRing'], newKey = KL) {
  const input: LegacyPasswordChangeInput = { s: S_FILE, w: W, newKey, oldRing, observedMtimeMs: MTIME, sourceSha256: 'ee'.repeat(32) };
  return absorbLegacyPasswordChange(input, testContext(ringOf(E1), NOW));
}

function genesisPid(id: string): string | undefined {
  return getRegister(genesis.state, pw(id))?.sibs[0].pid;
}

function plain(state: SyncState, id: string, only = ringOf(EL)): unknown[] {
  return (getRegister(state, pw(id))?.sibs ?? []).map((s) =>
    s.flags & SIB_UNDECRYPTABLE ? 'undecryptable' : readSecret(s.value as Uint8Array, only),
  );
}

describe('legacy password change with the old key (4.8)', () => {
  const res = absorb(buildKeyRing(W, E1, LINEAGE));

  it('adds E2 = KCV(new key) with parent E1, the wrap, and a pseudo dot on the epoch register', () => {
    expect(currentEpochId(res.s1)).toBe(EL.epochId);
    const rec = res.s1.epochs.get(EL.epochId);
    expect(rec).toMatchObject({ parent: E1.epochId, salt: 'salt-new', verification: NEW.meta.get('verification') });
    const epochSibs = getRegister(res.s1, epochRegKey())?.sibs ?? [];
    expect(epochSibs).toHaveLength(1);
    expect(epochSibs[0]).toMatchObject({ dev: 0, ms: MTIME, lt: MTIME, value: EL.epochId });
    const wrap = [...res.s1.wraps.values()].find((w) => w.epochId === EL.epochId);
    expect(wrap && unwrapValidated(wrap, EL.kEpoch)?.equals(E1.kEpoch)).toBe(true);
    expect(res.ring.byEpoch.has(E1.epochId)).toBe(true);
  });

  it('absorbs precisely: re-encrypted but unchanged secrets gain no sibling', () => {
    const before = getRegister(genesis.state, pw('e1'))?.sibs[0];
    const after = getRegister(res.s1, pw('e1'))?.sibs ?? [];
    expect(after).toHaveLength(1);
    expect(after[0].pid).toBe(before?.pid);
    expect(after[0].vhash).toBe(vhashOfSecret(pw('e1'), 'alpha', EL.kSync));
    expect(plain(res.s1, 'e1')).toEqual([{ kind: 'current', plaintext: 'alpha' }]);
  });

  it('records real legacy edits as new pseudo siblings under E2', () => {
    expect(plain(res.s1, 'e3')).toEqual([{ kind: 'current', plaintext: 'gamma2' }]);
    const edit = getRegister(res.s1, pw('e3'))?.sibs[0];
    expect(edit?.pid).not.toBe(genesisPid('e3'));
    expect(edit?.ms).toBeGreaterThan(0);
    expect(edit?.vhash).toBe(vhashOfSecret(pw('e3'), 'gamma2', EL.kSync));
    expect(getRegister(res.s1, HOST1)?.sibs.map((s) => [s.dev, s.value])).toEqual([[0, 'h2']]);
  });

  it('moves W to E2 without losing its unpublished edit, and redacts E1 in S1', () => {
    expect(plain(res.w, 'e2')).toEqual([{ kind: 'current', plaintext: 'beta-local' }]);
    expect(res.undecryptable).toBe(0);
    expect(res.s1.epochs.get(E1.epochId)?.verification).toBeNull();
  });
});

describe('legacy password change without the old key (4.8)', () => {
  const res = absorb(null);
  const precise = absorb(buildKeyRing(W, E1, LINEAGE));

  it('absorbs non-secret edits exactly like a device holding the old key', () => {
    expect(getRegister(res.s1, HOST1)).toEqual(getRegister(precise.s1, HOST1));
    expect(getRegister(res.s1, epochRegKey())?.sibs).toEqual(getRegister(precise.s1, epochRegKey())?.sibs);
    expect(res.s1.wraps.size).toBe(0);
    expect([...res.ring.byEpoch.keys()]).toEqual([EL.epochId]);
  });

  it("gives each secret a pseudo sibling from S's plaintext under E2", () => {
    expect(plain(res.s1, 'e1')).toEqual([{ kind: 'current', plaintext: 'alpha' }]);
    expect(getRegister(res.s1, pw('e1'))?.sibs[0].pid).not.toBe(genesisPid('e1'));
    expect(plain(res.s1, 'e3')).toEqual([{ kind: 'current', plaintext: 'gamma2' }]);
  });

  it("keeps W's unpublished secret as an undecryptable sibling and counts it", () => {
    expect(plain(res.w, 'e2')).toEqual(['undecryptable']);
    expect(res.undecryptable).toBe(1);
    expect(res.s1.epochs.get(E1.epochId)?.salt).toBe('salt1');
  });
});

describe('legacy password change over an epoch two devices wrote (4.3 rule 4)', () => {
  it('replaces every app sibling holding the old epoch id, so no epoch conflict appears', () => {
    const key = epochRegKey();
    const onE1 = (dev: number): Sibling => ({
      dev, ms: T0 + dev, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, E1.epochId), flags: 0, value: E1.epochId, prevVhash: null,
    });
    const s = { ...S_FILE, state: withRegister(S_FILE.state, key, [onE1(5), onE1(6)], pmemOf(S_FILE.state, key)) };
    const input: LegacyPasswordChangeInput = { s, w: W, newKey: KL, oldRing: null, observedMtimeMs: MTIME, sourceSha256: 'ee'.repeat(32) };
    const res = absorbLegacyPasswordChange(input, testContext(ringOf(E1), NOW));
    expect(getRegister(res.s1, key)?.sibs.map((x) => [x.dev, x.value])).toEqual([[0, EL.epochId]]);
  });
});

describe('legacy password change preconditions', () => {
  it('rejects a key that does not open the new verification token', () => {
    expect(() => absorb(null, K1)).toThrow(SyncCoreError);
  });
});
