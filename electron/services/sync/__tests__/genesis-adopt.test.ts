// @vitest-environment node
// Review finding 4 (G3, spec 4.4 and 4.9): adopting the shared file's genesis must not reset a
// row only W knows, and W's newer pre-sync values must still be offered for review when W
// edited another field of the row after its own genesis.
import { describe, expect, it } from 'vitest';
import { buildSyntheticFromRows, type SyntheticOptions } from '../candidates.js';
import { regKey } from '../catalog.js';
import { adoptGenesis, genesisFromContent } from '../genesis.js';
import { makeImplicitProvider, vhashOfValue } from '../hashing.js';
import { materialize } from '../materialize.js';
import { merge } from '../merge.js';
import { StateBuilder, makeRegister, pmemOf, provisionalValue } from '../state-view.js';
import { TBL, type ContentSnapshot, type RegKey, type SyncState } from '../types.js';
import {
  DAY,
  GENESIS_ID,
  K0,
  KEY0,
  K_OLD,
  LINEAGE,
  OTHER_GENESIS_ID,
  T0,
  counterRandom,
  entry,
  iso,
  makeCtx,
  ring,
  seal,
  snapshot,
} from './genesis-fixtures.js';

const E = TBL.entries;
const implicit = makeImplicitProvider(K0.kSync);
const LEFTOVERS: SyntheticOptions = { source: 'genesis-leftovers', label: 'Differences between two copies', staleByNature: true };
const W_DEV = 5;

function runGenesis(content: ContentSnapshot, genesisId: string): ReturnType<typeof genesisFromContent> {
  return genesisFromContent({ content, genesisId, lineageId: LINEAGE, k0: K0, ring: ring(K0, K_OLD), randomBytes: counterRandom('g') });
}

function appEdit(state: SyncState, key: RegKey, value: string, ms: number): SyncState {
  const b = new StateBuilder(state);
  const sib = { dev: W_DEV, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null };
  b.setRegister(makeRegister(key, [sib], pmemOf(state, key)));
  b.joinVv(W_DEV, { ms, c: 0 });
  b.addDev({ dev: W_DEV, deviceUuid: 'device-w', startedMs: ms });
  return b.build();
}

/** W edited after its genesis; S1 has another genesis; M = adoptGenesis; M content as materialized over W's. */
function adopt(versionW: ContentSnapshot, versionS: ContentSnapshot, edit: { key: RegKey; value: string; ms: number }) {
  const g = runGenesis(versionW, GENESIS_ID);
  const w = appEdit(g.state, edit.key, edit.value, edit.ms);
  const wMat = materialize(w, versionW, g.cache, { implicit, currentEpoch: null });
  const adopted = adoptGenesis(w, runGenesis(versionS, OTHER_GENESIS_ID).state, implicit);
  const m = adopted.merged.state;
  const mMat = materialize(m, versionW, wMat.cache, { implicit, currentEpoch: null });
  const upserts = mMat.plan.upsertEntries.map((r) => [r.id, r] as const);
  const mContent: ContentSnapshot = { ...versionW, entries: new Map([...versionW.entries, ...upserts]) };
  const cand = buildSyntheticFromRows(m, mContent, adopted.leftovers, LEFTOVERS, makeCtx(ring(K0)), implicit);
  return { m, mMat, cand };
}

describe('G3 adoptGenesis (finding 4)', () => {
  it('keeps every pre-sync field of a row only W knows and edited after its genesis', () => {
    const versionW = snapshot({
      entries: [
        entry('e1', { name: 'Shared', host: 'h1' }),
        entry('e2', {
          name: 'Prod DB',
          host: 'db.old',
          username: 'admin',
          password_encrypted: seal('s3cret', KEY0),
          updated_at: iso(T0 + 2 * DAY),
        }),
      ],
    });
    const versionS = snapshot({ entries: [entry('e1', { name: 'Shared', host: 'h1' })] });
    const { m, mMat, cand } = adopt(versionW, versionS, { key: regKey(E, 'e2', 'host'), value: 'db.new', ms: T0 + 10 * DAY });
    const value = (reg: string) => provisionalValue(m, regKey(E, 'e2', reg), null);
    expect([value('name'), value('host'), value('username'), value('entry_type')]).toEqual(['Prod DB', 'db.new', 'admin', 'ssh']);
    expect(value('password')).not.toBeNull();
    const row = mMat.plan.upsertEntries.find((r) => r.id === 'e2');
    expect(row === undefined || row.name === 'Prod DB').toBe(true);
    expect(cand.preview.changedFields).toEqual([]);
  });

  it("offers W's newer pre-sync value even when W edited another field of the row later", () => {
    const versionW = snapshot({ entries: [entry('e1', { name: 'Shared-new', host: 'h1', updated_at: iso(T0 + 5 * DAY) })] });
    const versionS = snapshot({ entries: [entry('e1', { name: 'Shared', host: 'h1', updated_at: iso(T0 + DAY) })] });
    const { m, cand } = adopt(versionW, versionS, { key: regKey(E, 'e1', 'port'), value: '2222', ms: T0 + 10 * DAY });
    expect(provisionalValue(m, regKey(E, 'e1', 'name'), null)).toBe('Shared');
    expect(cand.preview.changedFields.map((f) => [f.current, f.incoming])).toEqual([['Shared', 'Shared-new']]);
    const accepted = merge(m, cand.state, implicit).state;
    const names = accepted.rows.get('1:e1')?.regs.get('name')?.sibs.map((s) => s.value).sort();
    expect(names).toEqual(['Shared', 'Shared-new']);
  });

  it("does not offer W's pre-sync value when the shared file's value is newer", () => {
    const versionW = snapshot({ entries: [entry('e1', { name: 'Shared-old', host: 'h1', updated_at: iso(T0 + DAY) })] });
    const versionS = snapshot({ entries: [entry('e1', { name: 'Shared', host: 'h1', updated_at: iso(T0 + 5 * DAY) })] });
    const { cand } = adopt(versionW, versionS, { key: regKey(E, 'e1', 'port'), value: '2222', ms: T0 + 10 * DAY });
    expect(cand.preview.changedFields).toEqual([]);
    expect(cand.state.rows.size).toBe(0);
  });
});
