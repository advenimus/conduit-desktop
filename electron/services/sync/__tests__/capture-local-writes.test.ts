// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt } from '../../vault/crypto.js';
import { applyLocalWrites, ownerClaimWrite, prepareWrite, presenceWrite } from '../capture-local.js';
import { IMPLICIT_PMEM, LIFE_DEAD, LIFE_LIVE, deviceRegKey, ownerRegKey, regKey, rowKey } from '../catalog.js';
import { prevOf, vhashOfSecret, vhashOfValue } from '../hashing.js';
import { StateBuilder, emptyState, getRegister, makeRegister, rowKeyStr, rowLife } from '../state-view.js';
import { SIB_UNDECRYPTABLE, TBL, type LocalWrite, type PresenceValue, type Sibling, type SyncState } from '../types.js';
import {
  DEV_A,
  DEV_B,
  GENESIS,
  K_CURRENT,
  LINEAGE,
  createVault,
  dot,
  implicitFor,
  initialState,
  makeCtx,
  readContent,
  type VaultFixture,
} from './capture-fixtures.js';

const WRITE_MS = 7_000;
const ctx = makeCtx();
const implicit = implicitFor(ctx);
const att = (interactive: boolean) => ({ kind: 'local', dot: dot(DEV_A, WRITE_MS), interactive }) as const;
const ek = (id: string, reg: string) => regKey(TBL.entries, id, reg);

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

function app(dev: number, ms: number, key: ReturnType<typeof regKey>, value: string): Sibling {
  return { dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null };
}

function withRegister(state: SyncState, key: ReturnType<typeof regKey>, sibs: Sibling[], vvMs: number): SyncState {
  const b = new StateBuilder(state);
  b.setRegister(makeRegister(key, sibs, getRegister(state, key)?.pmem ?? IMPLICIT_PMEM));
  for (const s of sibs) if (s.dev > 0) b.joinVv(s.dev, { ms: vvMs, c: 0 });
  return b.build();
}

describe('prepareWrite', () => {
  it('normalizes json values to JCS and hashes plain values', () => {
    const w = prepareWrite(ek('e1', 'config.opts'), { value: '{ "b": 1, "a": [2] }' }, ctx);
    expect(w.value).toBe('{"a":[2],"b":1}');
    expect(w.vhash).toBe(vhashOfValue(ek('e1', 'config.opts'), '{"a":[2],"b":1}'));
    expect(w.mode).toBeUndefined();
  });

  it('encrypts secrets under the current epoch with a keyed vhash; empty plaintext is NULL', () => {
    const w = prepareWrite(ek('e1', 'password'), { plaintext: 'hunter2' }, ctx, 'replace-all');
    expect(decrypt(Buffer.from(w.value as Uint8Array), K_CURRENT).toString('utf8')).toBe('hunter2');
    expect(w.vhash).toBe(vhashOfSecret(ek('e1', 'password'), 'hunter2', ctx.keys.current.kSync));
    expect(w.mode).toBe('replace-all');
    const empty = prepareWrite(ek('e1', 'password'), { plaintext: '' }, ctx);
    expect(empty.value).toBeNull();
    expect(empty.vhash).toBe(vhashOfSecret(ek('e1', 'password'), null, ctx.keys.current.kSync));
  });

  it('copies an existing sibling and rejects mismatched inputs', () => {
    const s = app(DEV_B, 5, ek('e1', 'host'), 'h');
    expect(prepareWrite(ek('e1', 'host'), { sibling: s }, ctx)).toEqual({ key: ek('e1', 'host'), value: 'h', vhash: s.vhash });
    expect(() => prepareWrite(ek('e1', 'host'), { sibling: { ...s, flags: SIB_UNDECRYPTABLE } }, ctx)).toThrow();
    expect(() => prepareWrite(ek('e1', 'host'), { plaintext: 'x' }, ctx)).toThrow();
    expect(() => prepareWrite(ek('e1', 'password'), { value: 'x' }, ctx)).toThrow();
    expect(() => prepareWrite(ek('e1', 'no_such_column'), { value: 'x' }, ctx)).toThrow();
  });

  it('builds presence and owner-claim writes with JCS values', () => {
    const presence: PresenceValue = {
      platform: 'darwin', name: 'Mac', app_version: '0.18.0', first_seen_ms: 1, last_active_ms: 2,
      session_open: 1, session_since_ms: 2, account_hint: null, file_hint: null, side_files_seen_ms: null,
    };
    const p = presenceWrite(presence, ctx);
    expect(p.key).toEqual(deviceRegKey(ctx.deviceUuid));
    expect(JSON.parse(p.value as string)).toEqual(presence);
    expect(Object.keys(JSON.parse(p.value as string))).toEqual([...Object.keys(presence)].sort());
    const o = ownerClaimWrite({ d: ctx.deviceUuid, a: null }, ctx);
    expect(o.key).toEqual(ownerRegKey());
    expect(o.value).toBe(`{"a":null,"d":"${ctx.deviceUuid}"}`);
  });
});

describe('applyLocalWrites', () => {
  it('inserts an unknown row: _life added, default-valued writes left implicit', () => {
    const base = emptyState(LINEAGE, GENESIS, 0);
    const writes: LocalWrite[] = [
      prepareWrite(ek('n1', 'name'), { value: 'New' }, ctx),
      prepareWrite(ek('n1', 'entry_type'), { value: 'ssh' }, ctx),
      prepareWrite(ek('n1', 'host'), { value: null }, ctx),
      prepareWrite(ek('n1', 'is_favorite'), { value: 0 }, ctx),
    ];
    const res = applyLocalWrites(base, writes, att(true), ctx, implicit);
    expect(rowLife(res.state, rowKey(TBL.entries, 'n1'))).toBe('live');
    expect(getRegister(res.state, ek('n1', '_life'))?.sibs[0]).toMatchObject({ value: LIFE_LIVE, dev: DEV_A, ms: WRITE_MS });
    expect(getRegister(res.state, ek('n1', 'name'))?.pmem).toBeNull();
    expect(getRegister(res.state, ek('n1', 'host'))).toBeUndefined();
    expect(getRegister(res.state, ek('n1', 'is_favorite'))).toBeUndefined();
    expect(res.state.vv.get(DEV_A)).toEqual({ ms: WRITE_MS, c: 0 });
    expect(res.stats.appWrites).toBe(3);
  });

  it('force-stamps a resolution equal to the provisional value, replacing every sibling', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', host: 'a' });
    const init = initialState(readContent(fx.raw), ctx);
    const host = ek(ent.id, 'host');
    const conflicted = withRegister(init.state, host, [...getRegister(init.state, host)!.sibs, app(DEV_B, 900, host, 'b')], 900);
    const res = applyLocalWrites(conflicted, [prepareWrite(host, { value: 'a' }, ctx)], att(true), ctx, implicit);
    const sibs = getRegister(res.state, host)!.sibs;
    expect(sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([[DEV_A, WRITE_MS, 'a']]);
    expect(sibs[0].prevVhash).toBe(prevOf(vhashOfValue(host, 'a')));
  });

  it('reassert keeps dead siblings; non-interactive mode keeps the rest of a conflict', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh' });
    const init = initialState(readContent(fx.raw), ctx);
    const life = ek(ent.id, '_life');
    const state = withRegister(init.state, life, [...getRegister(init.state, life)!.sibs, app(DEV_B, 900, life, LIFE_DEAD)], 900);
    const re = applyLocalWrites(state, [prepareWrite(life, { value: LIFE_LIVE }, ctx, 'reassert')], att(false), ctx, implicit);
    expect(getRegister(re.state, life)!.sibs.map((s) => [s.value, s.dev])).toEqual([[LIFE_LIVE, DEV_A], [LIFE_DEAD, DEV_B]]);
  });

  it('a restore re-asserts the container chain; ruleR false skips it', () => {
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', folder_id: folder.id });
    const init = initialState(readContent(fx.raw), ctx);
    const life = ek(ent.id, '_life');
    const dead = withRegister(init.state, life, [app(DEV_B, 900, life, LIFE_DEAD)], 900);
    const restore = [prepareWrite(life, { value: LIFE_LIVE }, ctx, 'replace-all')];

    const res = applyLocalWrites(dead, restore, att(true), ctx, implicit);
    expect(rowLife(res.state, rowKey(TBL.entries, ent.id))).toBe('live');
    expect(getRegister(res.state, regKey(TBL.folders, folder.id, '_life'))!.sibs[0]).toMatchObject({ ms: WRITE_MS, value: LIFE_LIVE });
    expect(res.changedRows.map(rowKeyStr).sort()).toEqual([`1:${ent.id}`, `2:${folder.id}`].sort());

    const bare = applyLocalWrites(dead, restore, att(true), ctx, implicit, { ruleR: false });
    expect(getRegister(bare.state, regKey(TBL.folders, folder.id, '_life'))).toBe(getRegister(dead, regKey(TBL.folders, folder.id, '_life')));
  });

  it('a delete write triggers no rule R; duplicate keys throw; no writes returns the input', () => {
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', folder_id: folder.id });
    const init = initialState(readContent(fx.raw), ctx);
    const kill = prepareWrite(ek(ent.id, '_life'), { value: LIFE_DEAD }, ctx);
    const res = applyLocalWrites(init.state, [kill], att(true), ctx, implicit);
    expect(res.changedRows.map(rowKeyStr)).toEqual([`1:${ent.id}`]);
    expect(() => applyLocalWrites(init.state, [kill, kill], att(true), ctx, implicit)).toThrow();
    expect(applyLocalWrites(init.state, [], att(true), ctx, implicit).state).toBe(init.state);
  });
});
