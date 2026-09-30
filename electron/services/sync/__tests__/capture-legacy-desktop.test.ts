// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt } from '../../vault/crypto.js';
import { captureFullPass } from '../capture-local.js';
import { applyHeld, captureLegacy } from '../capture-legacy.js';
import { LIFE_DEAD, LIFE_LIVE, META_ROW_ID, metaRegKey, regKey, rowKey } from '../catalog.js';
import { canonicalDump } from '../digest.js';
import { baseRefOf, pidOf, vhashOfSecret, vhashOfValue, vhashUndecryptable, vrefSecret } from '../hashing.js';
import { identityKey } from '../sibling.js';
import { StateBuilder, getRegister, headOf, makeRegister, recoveryFrom, rowLife } from '../state-view.js';
import { FUTURE_CAP_MS, SIB_UNDECRYPTABLE, TBL, type LegacyAttribution, type RowCache, type SyncState } from '../types.js';
import {
  DEV_A,
  DEV_B,
  K_CURRENT,
  K_OLDER,
  K_UNKNOWN,
  MTIME_MS,
  SOURCE_SHA,
  cacheFor,
  createVault,
  dot,
  epochKeys,
  grdb,
  implicitFor,
  initialState,
  iosSaveEntry,
  legacyAtt,
  makeCtx,
  readContent,
  ringOf,
  sealWith,
  simulateLoad,
  type TestCtx,
  type VaultFixture,
} from './capture-fixtures.js';

const baseCtx = makeCtx();
const ek = (id: string, reg: string) => regKey(TBL.entries, id, reg);
const T1 = Date.parse('2026-09-24T09:00:00.000Z');
const T2 = Date.parse('2026-09-24T10:00:00.000Z');

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

interface Published {
  readonly state: SyncState;
  readonly cache: RowCache;
}

function absorb(v: VaultFixture, pub: Published, overrides: Partial<LegacyAttribution> = {}, ctx: TestCtx = baseCtx) {
  const content = readContent(v.raw);
  const x = simulateLoad(pub.state, content, pub.cache);
  const att = legacyAtt(ctx, { recover: recoveryFrom(pub.state), ...overrides });
  return { x, res: captureLegacy({ state: x, content, cache: pub.cache, implicit: implicitFor(ctx) }, att, ctx) };
}

function publish(v: VaultFixture, ctx: TestCtx = baseCtx): Published {
  return initialState(readContent(v.raw), ctx, 1_000);
}

describe('desktop 0.17 patterns', () => {
  it('re-encrypt on every update: only the edited field changes', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'old', entry_type: 'ssh', password: 'pw', private_key: 'key' });
    const pub = publish(fx);
    fx.vault.updateEntry(ent.id, { name: 'new' });
    const { x, res } = absorb(fx, pub);
    expect(getRegister(res.state, ek(ent.id, 'name'))!.sibs.map((s) => [s.dev, s.value])).toEqual([[0, 'new']]);
    expect(getRegister(res.state, ek(ent.id, 'password'))).toBe(getRegister(x, ek(ent.id, 'password')));
    expect(getRegister(res.state, ek(ent.id, 'private_key'))).toBe(getRegister(x, ek(ent.id, 'private_key')));
    expect(res.stats.legacyEdits).toBe(1);
  });

  it('deleteEntry: dead at the mtime, cascaded history hidden (rule H), vanished values repaired', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'E', entry_type: 'ssh', username: 'root', password: 'new' });
    const hid = fx.vault.recordPasswordHistory(ent.id, 'root', 'old', 'user');
    const pub = publish(fx);
    fx.vault.deleteEntry(ent.id);
    const { res } = absorb(fx, pub);

    expect(getRegister(res.state, ek(ent.id, '_life'))!.sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([[0, MTIME_MS, LIFE_DEAD]]);
    const histLife = regKey(TBL.history, hid, '_life');
    expect(getRegister(res.state, histLife)).toEqual(getRegister(pub.state, histLife));
    for (const key of [ek(ent.id, 'username'), ek(ent.id, 'password'), regKey(TBL.history, hid, 'password')]) {
      const head = headOf(key.reg, getRegister(res.state, key)!.sibs);
      expect(head?.value).toEqual(headOf(key.reg, getRegister(pub.state, key)!.sibs)?.value);
    }
    expect(res.notices).toEqual([]);
    expect(res.stats.legacyDeletes).toBe(1);
  });

  it('reports values of vanished rows that cannot be recovered', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'E', entry_type: 'ssh', host: 'h' });
    const pub = publish(fx);
    fx.vault.deleteEntry(ent.id);
    const { res } = absorb(fx, pub, { recover: undefined });
    expect(res.notices.map((n) => [n.kind, n.key, n.count > 0])).toEqual([['value-unrecoverable', null, true]]);
  });

  it('recursive folder delete: every row dies with a pseudo dot at the mtime', () => {
    fx = createVault();
    const top = fx.vault.createFolder({ name: 'top' });
    const sub = fx.vault.createFolder({ name: 'sub', parent_id: top.id });
    const e1 = fx.vault.createEntry({ name: 'e1', entry_type: 'ssh', folder_id: sub.id });
    const pub = publish(fx);
    fx.vault.deleteFolder(top.id);
    const { res } = absorb(fx, pub);
    for (const row of [rowKey(TBL.folders, top.id), rowKey(TBL.folders, sub.id), rowKey(TBL.entries, e1.id)]) {
      expect(getRegister(res.state, regKey(row.tbl, row.rowId, '_life'))!.sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([
        [0, MTIME_MS, LIFE_DEAD],
      ]);
    }
  });
});

describe('hold rule and applyHeld (4.3 rule 2, 7.3)', () => {
  function heldScenario(att: Partial<LegacyAttribution>) {
    fx = createVault();
    const doomed = fx.vault.createEntry({ name: 'D', entry_type: 'ssh' });
    const stale = fx.vault.createEntry({ name: 'S', entry_type: 'ssh', host: 'A' });
    const plain = fx.vault.createEntry({ name: 'N', entry_type: 'ssh', notes: 'n1' });
    const pub1 = publish(fx);
    fx.vault.updateEntry(stale.id, { host: 'B' });
    const content = readContent(fx.raw);
    const input = { state: pub1.state, content, cache: pub1.cache, implicit: implicitFor(baseCtx) };
    const edit = captureFullPass(input, { kind: 'local', dot: dot(DEV_A, 2_000), interactive: false }, baseCtx);
    const pub2 = { state: edit.state, cache: cacheFor(content) };
    fx.vault.deleteEntry(doomed.id);
    iosSaveEntry(fx.raw, stale.id, { host: 'A' }, T2);
    iosSaveEntry(fx.raw, plain.id, { notes: 'n2' }, T2);
    return { pub2, doomed, stale, plain, ...absorb(fx, pub2, att) };
  }

  it('holds legacy deletes and stale reverts while side files are present, applying other edits', () => {
    const { pub2, doomed, stale, plain, res } = heldScenario({ sideFilesPresent: true });
    expect(rowLife(res.state, rowKey(TBL.entries, doomed.id))).toBe('live');
    expect(getRegister(res.state, ek(stale.id, 'host'))!.sibs.map((s) => [s.dev, s.value])).toEqual([[DEV_A, 'B']]);
    expect(getRegister(res.state, ek(plain.id, 'notes'))!.sibs.map((s) => [s.dev, s.value])).toEqual([[0, 'n2']]);
    const w = getRegister(pub2.state, ek(doomed.id, '_life'))!.sibs[0];
    expect(res.held.map((h) => [h.kind, h.key.rowId])).toEqual([['stale-revert', stale.id], ['delete', doomed.id]]);
    const del = res.held[1];
    expect(del).toMatchObject({ replaces: identityKey(w), sourceSha256: SOURCE_SHA, heldAtMs: baseCtx.now() });
    expect(del.sibling).toMatchObject({ dev: 0, ms: MTIME_MS, value: LIFE_DEAD });
    expect(del.pmemAdd).toEqual({ ms: MTIME_MS, ids: [del.sibling.pid] });
    expect(res.contentRepairNeeded).toBe(true);
    expect(res.stats.legacyHeld).toBe(2);
  });

  it('holds on the server side-files flag too; applyHeld applies once and then skips', () => {
    const { doomed, stale, res } = heldScenario({ serverSideFilesFlagRecent: true });
    expect(res.held).toHaveLength(2);
    const applied = applyHeld(res.state, res.held, implicitFor(baseCtx), baseCtx);
    expect(rowLife(applied.state, rowKey(TBL.entries, doomed.id))).toBe('dead');
    expect(getRegister(applied.state, ek(stale.id, 'host'))!.sibs.map((s) => [s.dev, s.value])).toEqual([[0, 'A']]);
    expect(applied.stats).toMatchObject({ legacyDeletes: 1, legacyEdits: 1 });
    const again = applyHeld(applied.state, res.held, implicitFor(baseCtx), baseCtx);
    expect(again.state).toBe(applied.state);
    expect(again.changed).toBe(false);
  });
});

describe('filters, secrets, rule R and determinism', () => {
  it('skipRow ignores a row (its loaded values repaired); allowDelete false keeps a row', () => {
    fx = createVault();
    const skipped = fx.vault.createEntry({ name: 'K', entry_type: 'ssh', host: 'keep' });
    const kept = fx.vault.createEntry({ name: 'X', entry_type: 'ssh' });
    const pub = publish(fx);
    iosSaveEntry(fx.raw, skipped.id, { host: 'older' }, T1);
    fx.vault.deleteEntry(kept.id);
    const { res } = absorb(fx, pub, {
      filter: { skipRow: (row) => row.rowId === skipped.id, allowDelete: (row) => row.rowId !== kept.id },
    });
    expect(getRegister(res.state, ek(skipped.id, 'host'))).toEqual(getRegister(pub.state, ek(skipped.id, 'host')));
    expect(rowLife(res.state, rowKey(TBL.entries, kept.id))).toBe('live');
    expect(res.stats).toMatchObject({ legacyEdits: 0, legacyDeletes: 0 });
  });

  it('absorbs a stale-key secret re-encrypted under E_abs and keeps an unreadable one as undecryptable', () => {
    const ctx = makeCtx({ keys: ringOf(epochKeys(K_CURRENT), epochKeys(K_OLDER)) });
    fx = createVault();
    const a = fx.vault.createEntry({ name: 'a', entry_type: 'ssh', password: 'x' });
    const u = fx.vault.createEntry({ name: 'u', entry_type: 'ssh', password: 'y' });
    const pub = publish(fx, ctx);
    const staleCt = sealWith(K_OLDER, 'from-old-key');
    const lostCt = sealWith(K_UNKNOWN, 'lost');
    const upd = fx.raw.prepare('UPDATE entries SET password_encrypted = ?, updated_at = ? WHERE id = ?');
    upd.run(staleCt, grdb(T1), a.id);
    upd.run(lostCt, grdb(T1), u.id);
    const { res } = absorb(fx, pub, {}, ctx);

    const key = ek(a.id, 'password');
    const p = getRegister(res.state, key)!.sibs[0];
    expect(decrypt(Buffer.from(p.value as Uint8Array), K_CURRENT).toString('utf8')).toBe('from-old-key');
    expect(p.vhash).toBe(vhashOfSecret(key, 'from-old-key', ctx.keys.current.kSync));
    const w = headOf('password', getRegister(pub.state, key)!.sibs);
    expect(p.pid).toBe(pidOf(key, vrefSecret(staleCt), baseRefOf(w), ctx.keys.current.kPid));
    const bad = getRegister(res.state, ek(u.id, 'password'))!.sibs[0];
    expect(bad).toMatchObject({ dev: 0, flags: SIB_UNDECRYPTABLE, vhash: vhashUndecryptable(lostCt) });
    expect(res.stats.undecryptable).toBe(1);
    expect(res.notices.map((n) => [n.kind, n.count])).toEqual([['undecryptable-secrets', 1]]);
  });

  it('an unreadable legacy secret sits beside the readable value, which stays provisional (12 row 12)', () => {
    const ctx = makeCtx({ keys: ringOf(epochKeys(K_CURRENT), epochKeys(K_OLDER)) });
    fx = createVault();
    const u = fx.vault.createEntry({ name: 'u', entry_type: 'ssh', password: 'readable' });
    const pub = publish(fx, ctx);
    const lostCt = sealWith(K_UNKNOWN, 'lost');
    fx.raw.prepare('UPDATE entries SET password_encrypted = ?, updated_at = ? WHERE id = ?').run(lostCt, grdb(T1), u.id);
    const { res } = absorb(fx, pub, {}, ctx);
    const sibs = getRegister(res.state, ek(u.id, 'password'))!.sibs;
    expect(sibs.map((s) => s.flags)).toEqual(expect.arrayContaining([0, SIB_UNDECRYPTABLE]));
    const head = headOf('password', sibs)!;
    expect(head.flags).toBe(0);
    expect(decrypt(Buffer.from(head.value as Uint8Array), K_CURRENT).toString('utf8')).toBe('readable');
    expect(res.stats.undecryptable).toBe(1);
  });

  it('merges rule R contributions into one pseudo sibling per folder, keeping dead siblings', () => {
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const e1 = fx.vault.createEntry({ name: 'e1', entry_type: 'ssh', folder_id: folder.id });
    const e2 = fx.vault.createEntry({ name: 'e2', entry_type: 'ssh', folder_id: folder.id });
    const pub0 = publish(fx);
    const life = regKey(TBL.folders, folder.id, '_life');
    const b = new StateBuilder(pub0.state);
    const dead = { dev: DEV_B, ms: 900, c: 0, pid: '', lt: 0, vhash: vhashOfValue(life, LIFE_DEAD), flags: 0, value: LIFE_DEAD, prevVhash: null };
    b.setRegister(makeRegister(life, [...getRegister(pub0.state, life)!.sibs, dead], null));
    b.joinVv(DEV_B, { ms: 900, c: 0 });
    const pub = { state: b.build(), cache: pub0.cache };
    iosSaveEntry(fx.raw, e1.id, { host: 'one' }, T1);
    iosSaveEntry(fx.raw, e2.id, { host: 'two' }, T2);
    const { res } = absorb(fx, pub);
    const sibs = getRegister(res.state, life)!.sibs;
    expect(sibs.map((s) => [s.dev, s.ms, s.lt, s.value])).toEqual([[0, T2, T2, LIFE_LIVE], [DEV_B, 900, 0, LIFE_DEAD]]);
  });

  it('absorbs vault_meta as rowless changes at the (clamped) mtime', () => {
    fx = createVault();
    const pub = publish(fx);
    fx.raw.prepare("INSERT INTO vault_meta (key, value) VALUES ('cloud_sync_enabled', 'true')").run();
    const future = baseCtx.now() + 5 * FUTURE_CAP_MS;
    const { res } = absorb(fx, pub, { observedMtimeMs: future });
    const sib = getRegister(res.state, metaRegKey('cloud_sync_enabled'))!.sibs[0];
    expect(sib).toMatchObject({ dev: 0, ms: baseCtx.now() + FUTURE_CAP_MS, lt: baseCtx.now() + FUTURE_CAP_MS, value: 'true' });
    expect(res.changedRows).toEqual([rowKey(TBL.meta, META_ROW_ID)]);
  });

  it('is deterministic: the same bytes and inputs give the same pseudo siblings', () => {
    const ctx = makeCtx({ keys: ringOf(epochKeys(K_CURRENT), epochKeys(K_OLDER)) });
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const ent = fx.vault.createEntry({ name: 'e', entry_type: 'rdp', folder_id: folder.id, password: 'p', config: { a: 1 } });
    const gone = fx.vault.createEntry({ name: 'g', entry_type: 'ssh' });
    const pub = publish(fx, ctx);
    iosSaveEntry(fx.raw, ent.id, { host: 'h', password_encrypted: sealWith(K_OLDER, 'q'), config: '{"a":2}' }, T1);
    fx.vault.deleteEntry(gone.id);
    const first = absorb(fx, pub, {}, ctx).res;
    const second = absorb(fx, pub, {}, ctx).res;
    expect(canonicalDump(first.state)).toBe(canonicalDump(second.state));
    expect(first.stats).toEqual(second.stats);
  });
});
