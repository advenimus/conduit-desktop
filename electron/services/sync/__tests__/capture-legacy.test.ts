// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { captureFullPass } from '../capture-local.js';
import { captureLegacy, isDroppedChange, isStaleRevert, legacyDeleteTime, legacyEditTime } from '../capture-legacy.js';
import { LIFE_DEAD, LIFE_LIVE, regKey, rowKey } from '../catalog.js';
import { baseRefOf, pidOf, prevOf, vhashOfValue, vrefPlain } from '../hashing.js';
import { getRegister, headOf, recoveryFrom, rowKeyStr, rowLife } from '../state-view.js';
import {
  FUTURE_CAP_MS,
  SIB_VALUE_UNKNOWN,
  TBL,
  ZERO_PID,
  type LegacyAttribution,
  type RowCache,
  type Sibling,
  type SyncState,
} from '../types.js';
import {
  DEV_A,
  MTIME_MS,
  cacheFor,
  createVault,
  dot,
  grdb,
  implicitFor,
  initialState,
  iosSaveEntry,
  legacyAtt,
  makeCtx,
  readContent,
  simulateLoad,
  type VaultFixture,
} from './capture-fixtures.js';

const ctx = makeCtx();
const kPid = ctx.keys.current.kPid;
const ek = (id: string, reg: string) => regKey(TBL.entries, id, reg);
const fk = (id: string, reg: string) => regKey(TBL.folders, id, reg);
const T_EDIT = Date.parse('2026-09-24T10:00:00.000Z');

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

interface Published {
  readonly state: SyncState;
  readonly cache: RowCache;
}

/** Absorbs the vault's current content against the state and cache it was published with. */
function absorb(v: VaultFixture, pub: Published, overrides: Partial<LegacyAttribution> = {}) {
  const content = readContent(v.raw);
  const x = simulateLoad(pub.state, content, pub.cache);
  const att = legacyAtt(ctx, { recover: recoveryFrom(pub.state), ...overrides });
  const res = captureLegacy({ state: x, content, cache: pub.cache, implicit: implicitFor(ctx) }, att, ctx);
  return { x, res };
}

function publish(v: VaultFixture, prev: Published | null, ms: number): Published {
  const content = readContent(v.raw);
  if (prev === null) return initialState(content, ctx, ms);
  const input = { state: prev.state, content, cache: prev.cache, implicit: implicitFor(ctx) };
  const res = captureFullPass(input, { kind: 'local', dot: dot(DEV_A, ms), interactive: false }, ctx);
  return { state: res.state, cache: cacheFor(content) };
}

describe('legacy times and rules (4.3)', () => {
  it('derives edit times from updated_at (ISO or GRDB) and the pseudo memory', () => {
    expect(legacyEditTime(grdb(T_EDIT), null)).toEqual({ ms: T_EDIT, lt: T_EDIT });
    expect(legacyEditTime(new Date(T_EDIT).toISOString(), T_EDIT + 5)).toEqual({ ms: T_EDIT + 6, lt: T_EDIT });
    expect(legacyEditTime('not a date', null)).toEqual({ ms: 0, lt: 0 });
    expect(legacyEditTime(null, 0)).toEqual({ ms: 1, lt: 0 });
  });

  it('derives delete times from the observed mtime, clamped to now + 24 h and past the memory', () => {
    const now = ctx.now();
    expect(legacyDeleteTime(null, MTIME_MS, now)).toBe(MTIME_MS);
    expect(legacyDeleteTime(null, now + 3 * FUTURE_CAP_MS, now)).toBe(now + FUTURE_CAP_MS);
    expect(legacyDeleteTime(MTIME_MS + 50, MTIME_MS, now)).toBe(MTIME_MS + 51);
  });

  it('detects stale reverts only against an app sibling whose prev matches', () => {
    const key = ek('e', 'host');
    const w: Sibling = { dev: DEV_A, ms: 5, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, 'B'), flags: 0, value: 'B', prevVhash: prevOf(vhashOfValue(key, 'A')) };
    expect(isStaleRevert(w, vhashOfValue(key, 'A'))).toBe(true);
    expect(isStaleRevert(w, vhashOfValue(key, 'C'))).toBe(false);
    expect(isStaleRevert({ ...w, dev: 0, pid: ZERO_PID }, vhashOfValue(key, 'A'))).toBe(false);
    expect(isStaleRevert(null, vhashOfValue(key, 'A'))).toBe(false);
  });

  it('drops emptied config keys only when w held a value, and emptied document content always', () => {
    const key = ek('e', 'config.resolution');
    const full: Sibling = { dev: DEV_A, ms: 5, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, '"1080p"'), flags: 0, value: '{}', prevVhash: null };
    for (const empty of [null, '[]', '{}', '""']) expect(isDroppedChange(key, empty, full, 'rdp')).toBe(true);
    expect(isDroppedChange(key, '"720p"', full, 'rdp')).toBe(false);
    expect(isDroppedChange(key, '[]', { ...full, vhash: vhashOfValue(key, '[]') }, 'rdp')).toBe(false);
    expect(isDroppedChange(key, null, null, 'rdp')).toBe(false);
    expect(isDroppedChange(ek('e', 'config.content'), '""', null, 'document')).toBe(true);
    expect(isDroppedChange(ek('e', 'host'), null, full, 'ssh')).toBe(false);
  });
});

describe('iOS 1.0.5 patterns', () => {
  it('whole-row save without parent_entry_id, with GRDB dates and empty strings, changes only the edited field', () => {
    fx = createVault();
    const parent = fx.vault.createEntry({ name: 'P', entry_type: 'ssh' });
    const nested = fx.vault.createEntry({ name: 'N', entry_type: 'ssh', parent_entry_id: parent.id, notes: 'n1' });
    const pub = publish(fx, null, 1_000);
    iosSaveEntry(fx.raw, nested.id, { notes: 'n2' }, T_EDIT);
    const { x, res } = absorb(fx, pub);

    const notes = ek(nested.id, 'notes');
    const w = headOf('notes', getRegister(pub.state, notes)!.sibs);
    const pid = pidOf(notes, vrefPlain(notes, 'n2'), baseRefOf(w), kPid);
    expect(getRegister(res.state, notes)).toEqual({
      key: notes,
      sibs: [{ dev: 0, ms: T_EDIT, c: 0, pid, lt: T_EDIT, vhash: vhashOfValue(notes, 'n2'), flags: 0, value: 'n2', prevVhash: null }],
      pmem: { ms: T_EDIT, ids: [pid] },
    });
    for (const reg of ['container', 'host', 'domain', 'username', 'created_at']) {
      expect(getRegister(res.state, ek(nested.id, reg))).toBe(getRegister(x, ek(nested.id, reg)));
    }
    for (const row of [nested.id, parent.id]) {
      const life = getRegister(res.state, ek(row, '_life'))!.sibs;
      expect(life.map((s) => [s.dev, s.ms, s.lt, s.value])).toEqual([[0, T_EDIT, T_EDIT, LIFE_LIVE]]);
    }
    expect(res.stats).toMatchObject({ legacyEdits: 1, legacyDropped: 0, staleReverts: 0 });
    expect(res.changedRows.map(rowKeyStr).sort()).toEqual([`1:${nested.id}`, `1:${parent.id}`].sort());
    expect(res.contentRepairNeeded).toBe(false);
  });

  it('keeps settings a rebuilt config dropped (drop rule), recovering w and asking for a repair publish', () => {
    fx = createVault();
    const rdp = fx.vault.createEntry({ name: 'R', entry_type: 'rdp', config: { resolution: '1080p', sharedFolders: ['/tmp'] } });
    const cred = fx.vault.createEntry({ name: 'C', entry_type: 'credential', config: { ssh_auth_method: 'key' } });
    const pub = publish(fx, null, 1_000);
    iosSaveEntry(fx.raw, rdp.id, { config: '{"sharedFolders":[]}' }, T_EDIT);
    iosSaveEntry(fx.raw, cred.id, { config: '{}' }, T_EDIT);
    const { res } = absorb(fx, pub);

    for (const [key, value] of [
      [ek(rdp.id, 'config.resolution'), '"1080p"'],
      [ek(rdp.id, 'config.sharedFolders'), '["/tmp"]'],
      [ek(cred.id, 'config.ssh_auth_method'), '"key"'],
    ] as const) {
      const reg = getRegister(res.state, key)!;
      expect(reg.sibs.map((s) => [s.dev, s.value])).toEqual([[DEV_A, value]]);
    }
    expect(res.stats.legacyDropped).toBe(3);
    expect(res.contentRepairNeeded).toBe(true);
    expect(res.notices.map((n) => n.kind)).toEqual(['dropped-setting', 'dropped-setting', 'dropped-setting']);
    expect(res.changedRows).toEqual([]);
  });

  it('still drops a rebuilt setting when w cannot be recovered: w stays, flagged value-unknown', () => {
    fx = createVault();
    const rdp = fx.vault.createEntry({ name: 'R', entry_type: 'rdp', config: { resolution: '1080p' } });
    const pub = publish(fx, null, 1_000);
    iosSaveEntry(fx.raw, rdp.id, { config: '{}' }, T_EDIT);
    const { res } = absorb(fx, pub, { recover: undefined });
    const reg = getRegister(res.state, ek(rdp.id, 'config.resolution'))!;
    expect(reg.sibs.map((s) => [s.dev, s.value, s.flags])).toEqual([[DEV_A, null, SIB_VALUE_UNKNOWN]]);
    expect(reg.sibs[0].vhash).toBe(getRegister(pub.state, ek(rdp.id, 'config.resolution'))!.sibs[0].vhash);
    expect(res.notices.map((n) => n.kind)).toEqual(['value-unrecoverable', 'dropped-setting']);
    expect(res.stats.legacyDropped).toBe(1);
    expect(res.contentRepairNeeded).toBe(true);
  });

  it('never applies an emptied document', () => {
    fx = createVault();
    const doc = fx.vault.createEntry({ name: 'D', entry_type: 'document', config: { content: 'hello' } });
    const pub = publish(fx, null, 1_000);
    iosSaveEntry(fx.raw, doc.id, { config: '{"content":""}' }, T_EDIT);
    const { res } = absorb(fx, pub);
    expect(getRegister(res.state, ek(doc.id, 'config.content'))!.sibs.map((s) => s.value)).toEqual(['"hello"']);
    expect(res.notices.map((n) => [n.kind, n.key])).toEqual([['dropped-setting', ek(doc.id, 'config.content')]]);
  });

  it('turns a stale editor snapshot into a conflict (stale revert), secrets included', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'S', entry_type: 'ssh', host: 'A', password: 'old' });
    const pub1 = publish(fx, null, 1_000);
    const snapshot = readContent(fx.raw).entries.get(ent.id)!;
    fx.vault.updateEntry(ent.id, { host: 'B', password: 'new' });
    const pub2 = publish(fx, pub1, 2_000);
    iosSaveEntry(fx.raw, ent.id, { host: 'A', password_encrypted: snapshot.password_encrypted }, T_EDIT);
    const { res } = absorb(fx, pub2);

    const host = getRegister(res.state, ek(ent.id, 'host'))!.sibs;
    expect(host.map((s) => [s.dev, s.value])).toEqual([[0, 'A'], [DEV_A, 'B']]);
    const pw = getRegister(res.state, ek(ent.id, 'password'))!.sibs;
    expect(pw.map((s) => s.dev)).toEqual([0, DEV_A]);
    expect(pw[1].vhash).toBe(getRegister(pub2.state, ek(ent.id, 'password'))!.sibs[0].vhash);
    expect(res.stats.staleReverts).toBe(2);
    expect(res.held).toEqual([]);
  });

  it("keeps w provisional after a stale revert: the pseudo time is capped at w's (12 row 45)", () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'S', entry_type: 'ssh', host: 'A' });
    const pub1 = publish(fx, null, 1_000);
    fx.vault.updateEntry(ent.id, { host: 'B' });
    const pub2 = publish(fx, pub1, 2_000);
    iosSaveEntry(fx.raw, ent.id, { host: 'A', notes: 'typed on the phone' }, T_EDIT);
    const { res } = absorb(fx, pub2);
    const host = getRegister(res.state, ek(ent.id, 'host'))!;
    const w = host.sibs.find((s) => s.dev === DEV_A)!;
    const p = host.sibs.find((s) => s.dev === 0)!;
    expect(p.ms).toBeLessThanOrEqual(w.ms);
    expect(p.lt).toBe(T_EDIT);
    expect(headOf('host', host.sibs)!.value).toBe('B');
    expect(host.pmem?.ids).toContain(p.pid);
    expect(getRegister(res.state, ek(ent.id, 'notes'))!.sibs.map((s) => s.value)).toEqual(['typed on the phone']);
  });

  it('keeps an unrecoverable w of a stale revert as a value-unknown sibling (never provisional)', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'S', entry_type: 'ssh', host: 'A' });
    const pub1 = publish(fx, null, 1_000);
    fx.vault.updateEntry(ent.id, { host: 'B' });
    const pub2 = publish(fx, pub1, 2_000);
    iosSaveEntry(fx.raw, ent.id, { host: 'A' }, T_EDIT);
    const { res } = absorb(fx, pub2, { recover: () => undefined });
    const host = getRegister(res.state, ek(ent.id, 'host'))!.sibs;
    expect(host.map((s) => [s.dev, s.value, s.flags])).toEqual([[0, 'A', 0], [DEV_A, null, SIB_VALUE_UNKNOWN]]);
    expect(headOf('host', host)!.value).toBe('A');
    expect(res.notices.map((n) => n.kind)).toEqual(['value-unrecoverable']);
    expect(res.stats.staleReverts).toBe(1);
  });

  it('SET NULL folder delete: the folder dies at the mtime, its children move to root as edits', () => {
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const sub = fx.vault.createFolder({ name: 'G', parent_id: folder.id });
    const e1 = fx.vault.createEntry({ name: 'e1', entry_type: 'ssh', folder_id: folder.id });
    const pub = publish(fx, null, 1_000);
    const e1Updated = Date.parse(readContent(fx.raw).entries.get(e1.id)!.updated_at as string);
    fx.raw.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
    const { res } = absorb(fx, pub);

    const life = getRegister(res.state, fk(folder.id, '_life'))!.sibs;
    expect(life.map((s) => [s.dev, s.ms, s.lt, s.value])).toEqual([[0, MTIME_MS, MTIME_MS, LIFE_DEAD]]);
    expect(getRegister(res.state, ek(e1.id, 'container'))!.sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([[0, e1Updated, 'r']]);
    expect(getRegister(res.state, fk(sub.id, 'container'))!.sibs[0].value).toBe('r');
    expect(rowLife(res.state, rowKey(TBL.entries, e1.id))).toBe('live');
    expect(getRegister(res.state, ek(e1.id, '_life'))!.sibs.map((s) => s.dev)).toEqual([0]);
    expect(res.stats).toMatchObject({ legacyDeletes: 1, legacyEdits: 2 });
  });

  it('absorbs a legacy insert with GRDB dates and re-asserts its folder once', () => {
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const pub = publish(fx, null, 1_000);
    fx.raw
      .prepare(`INSERT INTO entries (id, name, entry_type, folder_id, host, config, tags, created_at, updated_at)
                VALUES ('ios1', 'phone', 'ssh', ?, 'h', '{}', '[]', ?, ?)`)
      .run(folder.id, grdb(T_EDIT), grdb(T_EDIT));
    const { res } = absorb(fx, pub);

    const life = getRegister(res.state, ek('ios1', '_life'))!;
    expect(life.sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([[0, T_EDIT, LIFE_LIVE]]);
    expect(life.pmem).toEqual({ ms: T_EDIT, ids: [life.sibs[0].pid] });
    expect(getRegister(res.state, ek('ios1', 'host'))!.sibs[0]).toMatchObject({ dev: 0, ms: T_EDIT, value: 'h' });
    expect(getRegister(res.state, ek('ios1', 'port'))).toBeUndefined();
    const folderLife = getRegister(res.state, fk(folder.id, '_life'))!.sibs;
    expect(folderLife.map((s) => [s.dev, s.ms, s.value])).toEqual([[0, T_EDIT, LIFE_LIVE]]);
  });

  it('returns the input state when the content still matches its tables', () => {
    fx = createVault();
    fx.vault.createEntry({ name: 'S', entry_type: 'ssh', host: 'A', password: 'p' });
    const pub = publish(fx, null, 1_000);
    const { x, res } = absorb(fx, pub);
    expect(res.state).toBe(x);
    expect(res.changed).toBe(false);
  });
});
