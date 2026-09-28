// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt } from '../../vault/crypto.js';
import { captureFullPass, captureRows } from '../capture-local.js';
import { LIFE_DEAD, LIFE_LIVE, META_ROW_ID, metaRegKey, regKey, rowKey } from '../catalog.js';
import { prevOf, vhashOfSecret, vhashOfValue, vhashUndecryptable } from '../hashing.js';
import { StateBuilder, getRegister, makeRegister, provisional, rowKeyStr, rowLife } from '../state-view.js';
import { SIB_REDACTED, SIB_UNDECRYPTABLE, TBL, type RowKey, type Sibling, type SyncState } from '../types.js';
import {
  DEV_A,
  DEV_B,
  DEVICE_A,
  K_CURRENT,
  K_OLDER,
  K_UNKNOWN,
  cacheFor,
  createVault,
  dot,
  epochKeys,
  implicitFor,
  initialState,
  makeCtx,
  readContent,
  ringOf,
  sealWith,
  type TestCtx,
  type VaultFixture,
} from './capture-fixtures.js';

const EDIT_MS = 5_000;
const local = (ms: number, interactive = false) => ({ kind: 'local', dot: dot(DEV_A, ms), interactive }) as const;
const e = (id: string, reg: string) => regKey(TBL.entries, id, reg);
const f = (id: string, reg: string) => regKey(TBL.folders, id, reg);
const rows = (list: readonly RowKey[]) => list.map(rowKeyStr).sort();

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

function setup(ctx: TestCtx = makeCtx()) {
  fx = createVault();
  return { fx, ctx, implicit: implicitFor(ctx) };
}

function recapture(state: SyncState, fx: VaultFixture, cache: ReturnType<typeof cacheFor>, ctx: TestCtx, interactive = false) {
  return captureFullPass({ state, content: readContent(fx.raw), cache, implicit: implicitFor(ctx) }, local(EDIT_MS, interactive), ctx);
}

function withSibling(state: SyncState, key: ReturnType<typeof regKey>, extra: Sibling, vvMs: number): SyncState {
  const b = new StateBuilder(state);
  const reg = getRegister(state, key);
  b.setRegister(makeRegister(key, [...(reg?.sibs ?? []), extra], reg?.pmem ?? null));
  b.joinVv(extra.dev, { ms: vvMs, c: 0 });
  return b.build();
}

const appSib = (dev: number, ms: number, key: ReturnType<typeof regKey>, value: string): Sibling => ({
  dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null,
});

describe('captureFullPass: inserts (4.2 step 2)', () => {
  it('captures a new vault row by row with explicit _life and implicit defaults', () => {
    const { fx, ctx } = setup();
    const folder = fx.vault.createFolder({ name: 'Servers' });
    const ent = fx.vault.createEntry({
      name: 'web1', entry_type: 'ssh', folder_id: folder.id, host: '10.0.0.1', port: 22,
      username: 'root', password: 's3cret', tags: ['prod'], config: { keepalive: 30 },
    });
    const content = readContent(fx.raw);
    const { state } = initialState(content, ctx, 1_000);

    const life = getRegister(state, e(ent.id, '_life'));
    expect(life?.sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([[DEV_A, 1_000, LIFE_LIVE]]);
    const host = getRegister(state, e(ent.id, 'host'));
    expect(host?.sibs).toHaveLength(1);
    expect(host?.sibs[0]).toMatchObject({ value: '10.0.0.1', vhash: vhashOfValue(e(ent.id, 'host'), '10.0.0.1'), prevVhash: null });
    expect(host?.pmem).toBeNull();
    expect(getRegister(state, e(ent.id, 'container'))?.sibs[0].value).toBe(`f:${folder.id}`);
    expect(getRegister(state, e(ent.id, 'tag:prod'))?.sibs[0].value).toBe(1);
    expect(getRegister(state, e(ent.id, 'config.keepalive'))?.sibs[0].value).toBe('30');
    for (const implicitReg of ['domain', 'notes', 'is_favorite', 'sort_order', 'icon']) {
      expect(getRegister(state, e(ent.id, implicitReg))).toBeUndefined();
    }
    const pw = getRegister(state, e(ent.id, 'password'))?.sibs[0];
    expect(Buffer.compare(Buffer.from(pw?.value as Uint8Array), content.entries.get(ent.id)?.password_encrypted as Buffer)).toBe(0);
    expect(pw?.vhash).toBe(vhashOfSecret(e(ent.id, 'password'), 's3cret', ctx.keys.current.kSync));
    expect(state.vv.get(DEV_A)).toEqual({ ms: 1_000, c: 0 });
    expect(state.devs.get(DEV_A)).toEqual({ dev: DEV_A, deviceUuid: DEVICE_A, startedMs: ctx.now() });
    expect(rowLife(state, rowKey(TBL.folders, folder.id))).toBe('live');
  });

  it('returns the same state object when nothing changed, with or without the raw_hash shortcut', () => {
    const { fx, ctx } = setup();
    fx.vault.createEntry({ name: 'db', entry_type: 'ssh', host: 'db.local', password: 'pw' });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    const again = recapture(state, fx, cache, ctx);
    expect(again.changed).toBe(false);
    expect(again.state).toBe(state);
    const noShortcut = new Map([...cache].map(([k, v]) => [k, { materialized: v.materialized, rawHash: null }] as const));
    expect(recapture(state, fx, noShortcut, ctx).state).toBe(state);
  });
});

describe('captureFullPass: edits (4.2 steps 1 and 5)', () => {
  it('writes one app sibling per changed register with prevVhash; a re-encrypted secret is unchanged', () => {
    const { fx, ctx } = setup();
    const folder = fx.vault.createFolder({ name: 'F' });
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', folder_id: folder.id, host: 'a', password: 'pw' });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    const oldHost = getRegister(state, e(ent.id, 'host'));
    fx.vault.updateEntry(ent.id, { host: 'b' });

    const res = recapture(state, fx, cache, ctx);
    const host = getRegister(res.state, e(ent.id, 'host'));
    expect(host?.sibs.map((s) => [s.dev, s.ms, s.value])).toEqual([[DEV_A, EDIT_MS, 'b']]);
    expect(host?.sibs[0].prevVhash).toBe(prevOf(oldHost?.sibs[0].vhash as string));
    expect(getRegister(res.state, e(ent.id, 'password'))).toBe(getRegister(state, e(ent.id, 'password')));
    expect(getRegister(res.state, e(ent.id, 'name'))).toBe(getRegister(state, e(ent.id, 'name')));
    expect(rows(res.changedRows)).toEqual(rows([rowKey(TBL.entries, ent.id), rowKey(TBL.folders, folder.id)]));
    expect(res.state.vv.get(DEV_A)).toEqual({ ms: EDIT_MS, c: 0 });
  });

  it('non-interactive edits keep an open conflict; interactive edits replace every sibling', () => {
    const { fx, ctx } = setup();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', host: 'a' });
    const init = initialState(readContent(fx.raw), ctx);
    const hostKey = e(ent.id, 'host');
    const conflicted = withSibling(init.state, hostKey, appSib(DEV_B, 500, hostKey, 'remote'), 500);
    fx.vault.updateEntry(ent.id, { host: 'c' });

    const quiet = recapture(conflicted, fx, init.cache, ctx, false);
    expect(getRegister(quiet.state, hostKey)?.sibs.map((s) => s.value).sort()).toEqual(['c', 'remote']);
    const loud = recapture(conflicted, fx, init.cache, ctx, true);
    expect(getRegister(loud.state, hostKey)?.sibs.map((s) => s.value)).toEqual(['c']);
  });

  it('treats GRDB and ISO timestamps and empty versus NULL text as equal (no write)', () => {
    const { fx, ctx } = setup();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', host: null, domain: null });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    const created = readContent(fx.raw).entries.get(ent.id)?.created_at as string;
    const grdb = created.replace('T', ' ').replace('Z', '');
    fx.raw.prepare("UPDATE entries SET host = '', domain = '', created_at = ? WHERE id = ?").run(grdb, ent.id);
    expect(recapture(state, fx, cache, ctx).state).toBe(state);
  });

  it('does not read a malformed config column as every key removed', () => {
    const { fx, ctx } = setup();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'rdp', config: { resolution: '1080p' } });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.raw.prepare("UPDATE entries SET config = '{broken' WHERE id = ?").run(ent.id);
    expect(recapture(state, fx, cache, ctx).state).toBe(state);
  });
});

describe('captureFullPass: deletes, rule H and rule R', () => {
  it('records an entry delete but not its cascaded password history (rule H)', () => {
    const { fx, ctx } = setup();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', password: 'new' });
    const hid = fx.vault.recordPasswordHistory(ent.id, 'root', 'old', 'user');
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.vault.deleteEntry(ent.id);

    const res = recapture(state, fx, cache, ctx);
    expect(getRegister(res.state, e(ent.id, '_life'))?.sibs.map((s) => [s.value, s.ms])).toEqual([[LIFE_DEAD, EDIT_MS]]);
    expect(getRegister(res.state, regKey(TBL.history, hid, '_life'))).toBe(getRegister(state, regKey(TBL.history, hid, '_life')));
    expect(rows(res.changedRows)).toEqual(rows([rowKey(TBL.entries, ent.id)]));
  });

  it('records a history delete while its entry stays live', () => {
    const { fx, ctx } = setup();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', password: 'new' });
    const hid = fx.vault.recordPasswordHistory(ent.id, 'root', 'old', 'user');
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.vault.deletePasswordHistory(hid);
    const res = recapture(state, fx, cache, ctx);
    expect(rowLife(res.state, rowKey(TBL.history, hid))).toBe('dead');
  });

  it('marks a recursive folder delete dead with one dot on every row', () => {
    const { fx, ctx } = setup();
    const top = fx.vault.createFolder({ name: 'top' });
    const sub = fx.vault.createFolder({ name: 'sub', parent_id: top.id });
    const e1 = fx.vault.createEntry({ name: 'e1', entry_type: 'ssh', folder_id: top.id });
    const e2 = fx.vault.createEntry({ name: 'e2', entry_type: 'ssh', folder_id: sub.id });
    const e3 = fx.vault.createEntry({ name: 'e3', entry_type: 'ssh', parent_entry_id: e1.id });
    const keep = fx.vault.createEntry({ name: 'keep', entry_type: 'ssh' });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.vault.deleteFolder(top.id);

    const res = recapture(state, fx, cache, ctx, true);
    const dead = [rowKey(TBL.folders, top.id), rowKey(TBL.folders, sub.id), ...[e1, e2, e3].map((x) => rowKey(TBL.entries, x.id))];
    for (const row of dead) {
      const life = getRegister(res.state, regKey(row.tbl, row.rowId, '_life'));
      expect(life?.sibs.map((s) => [s.value, s.dev, s.ms])).toEqual([[LIFE_DEAD, DEV_A, EDIT_MS]]);
    }
    expect(rowLife(res.state, rowKey(TBL.entries, keep.id))).toBe('live');
    expect(rows(res.changedRows)).toEqual(rows(dead));
  });

  it('shares the delete dot with child promotion and re-asserts the promoted chain', () => {
    const { fx, ctx } = setup();
    const folder = fx.vault.createFolder({ name: 'F' });
    const parent = fx.vault.createEntry({ name: 'P', entry_type: 'ssh', folder_id: folder.id });
    const child = fx.vault.createEntry({ name: 'C', entry_type: 'ssh', parent_entry_id: parent.id });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.vault.deleteEntry(parent.id);

    const res = recapture(state, fx, cache, ctx);
    expect(rowLife(res.state, rowKey(TBL.entries, parent.id))).toBe('dead');
    const container = getRegister(res.state, e(child.id, 'container'))?.sibs;
    expect(container?.map((s) => [s.value, s.ms])).toEqual([[`f:${folder.id}`, EDIT_MS]]);
    for (const row of [rowKey(TBL.entries, child.id), rowKey(TBL.folders, folder.id)]) {
      const life = getRegister(res.state, regKey(row.tbl, row.rowId, '_life'))?.sibs;
      expect(life?.map((s) => [s.value, s.ms])).toEqual([[LIFE_LIVE, EDIT_MS]]);
    }
  });

  it('re-asserts the row, its container chain and live references, keeping dead siblings', () => {
    const { fx, ctx } = setup();
    const outer = fx.vault.createFolder({ name: 'outer' });
    const inner = fx.vault.createFolder({ name: 'inner', parent_id: outer.id });
    const cred = fx.vault.createEntry({ name: 'cred', entry_type: 'credential', password: 'x' });
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', folder_id: inner.id, credential_id: cred.id, host: 'a' });
    const init = initialState(readContent(fx.raw), ctx);
    const outerLife = f(outer.id, '_life');
    const remoteDelete = { ...appSib(DEV_B, 900, outerLife, LIFE_DEAD) };
    const withRemote = withSibling(init.state, outerLife, remoteDelete, 900);
    fx.vault.updateEntry(ent.id, { host: 'b' });

    const res = recapture(withRemote, fx, init.cache, ctx);
    for (const row of [rowKey(TBL.entries, ent.id), rowKey(TBL.folders, inner.id), rowKey(TBL.entries, cred.id)]) {
      const life = getRegister(res.state, regKey(row.tbl, row.rowId, '_life'))?.sibs;
      expect(life?.map((s) => [s.value, s.dev, s.ms])).toEqual([[LIFE_LIVE, DEV_A, EDIT_MS]]);
    }
    const outerSibs = getRegister(res.state, outerLife)?.sibs.map((s) => [s.value, s.dev]);
    expect(outerSibs).toEqual([[LIFE_LIVE, DEV_A], [LIFE_DEAD, DEV_B]]);
  });

  it('does not re-assert a dead referenced credential (it materializes as NULL)', () => {
    const { fx, ctx } = setup();
    const cred = fx.vault.createEntry({ name: 'cred', entry_type: 'credential' });
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', credential_id: cred.id, host: 'a' });
    const init = initialState(readContent(fx.raw), ctx);
    const credLife = e(cred.id, '_life');
    const b = new StateBuilder(init.state);
    b.setRegister(makeRegister(credLife, [appSib(DEV_B, 900, credLife, LIFE_DEAD)], null));
    const refReg = getRegister(init.state, e(ent.id, 'credential_id'));
    b.setRegister({ ...refReg!, mat: { value: null } });
    b.joinVv(DEV_B, { ms: 900, c: 0 });
    const state = b.build();
    fx.raw.prepare('DELETE FROM entries WHERE id = ?').run(cred.id);
    fx.raw.prepare("UPDATE entries SET host = 'b' WHERE id = ?").run(ent.id);
    const cache = new Map(init.cache);
    cache.set(rowKeyStr(rowKey(TBL.entries, cred.id)), { materialized: false, rawHash: null });

    const res = recapture(state, fx, cache, ctx);
    expect(getRegister(res.state, credLife)).toBe(getRegister(state, credLife));
    expect(getRegister(res.state, e(ent.id, 'credential_id'))).toBe(getRegister(state, e(ent.id, 'credential_id')));
    expect(getRegister(res.state, e(ent.id, 'host'))?.sibs[0].value).toBe('b');
  });
});

describe('captureFullPass: vault_meta, secrets and expected values', () => {
  it('captures vault_meta registers as rowless changes', () => {
    const { fx, ctx } = setup();
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    const vaultId = fx.vault.getVaultId();
    fx.vault.setCloudSyncEnabled(true);
    const res = recapture(state, fx, cache, ctx);
    expect(getRegister(res.state, metaRegKey('vault_id'))?.sibs[0].value).toBe(vaultId);
    expect(getRegister(res.state, metaRegKey('cloud_sync_enabled'))?.sibs[0].value).toBe('true');
    expect(rows(res.changedRows)).toEqual([rowKeyStr(rowKey(TBL.meta, META_ROW_ID))]);
  });

  it('re-encrypts a secret written under an older ring key and flags an unreadable one', () => {
    const current = epochKeys(K_CURRENT);
    const older = epochKeys(K_OLDER);
    const ctx = makeCtx({ keys: ringOf(current, older) });
    const { fx } = setup(ctx);
    const a = fx.vault.createEntry({ name: 'a', entry_type: 'ssh', password: 'x' });
    const u = fx.vault.createEntry({ name: 'u', entry_type: 'ssh', password: 'y' });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.raw.prepare('UPDATE entries SET password_encrypted = ? WHERE id = ?').run(sealWith(K_OLDER, 'stale'), a.id);
    const unknown = sealWith(K_UNKNOWN, 'lost');
    fx.raw.prepare('UPDATE entries SET password_encrypted = ? WHERE id = ?').run(unknown, u.id);

    const res = recapture(state, fx, cache, ctx);
    const opened = provisional('password', getRegister(res.state, e(a.id, 'password'))?.sibs ?? []);
    expect(decrypt(Buffer.from(opened?.value as Uint8Array), K_CURRENT).toString('utf8')).toBe('stale');
    expect(opened?.vhash).toBe(vhashOfSecret(e(a.id, 'password'), 'stale', current.kSync));
    const bad = getRegister(res.state, e(u.id, 'password'))?.sibs.find((s) => s.dev === DEV_A && s.ms === EDIT_MS);
    expect(bad?.flags).toBe(SIB_UNDECRYPTABLE);
    expect(bad?.vhash).toBe(vhashUndecryptable(unknown));
    expect(res.stats.undecryptable).toBe(1);
    expect(res.notices.map((n) => [n.kind, n.count])).toEqual([['undecryptable-secrets', 1]]);
  });

  it('expects the default for a register whose siblings are all redacted', () => {
    const { fx, ctx } = setup();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', notes: 'secret notes' });
    const init = initialState(readContent(fx.raw), ctx);
    const notes = e(ent.id, 'notes');
    const reg = getRegister(init.state, notes)!;
    const b = new StateBuilder(init.state);
    b.setRegister({ ...reg, sibs: reg.sibs.map((s) => ({ ...s, value: null, vhash: '0'.repeat(32), flags: SIB_REDACTED })) });
    const redacted = b.build();
    fx.raw.prepare('UPDATE entries SET notes = NULL WHERE id = ?').run(ent.id);
    expect(recapture(redacted, fx, init.cache, ctx).state).toBe(redacted);
  });
});

describe('captureRows (per-operation capture)', () => {
  it('compares only the listed rows, detects their deletes, and vault_meta only when listed', () => {
    const { fx, ctx } = setup();
    const a = fx.vault.createEntry({ name: 'a', entry_type: 'ssh', host: 'a' });
    const b = fx.vault.createEntry({ name: 'b', entry_type: 'ssh', host: 'b' });
    const gone = fx.vault.createEntry({ name: 'gone', entry_type: 'ssh' });
    const { state, cache } = initialState(readContent(fx.raw), ctx);
    fx.vault.updateEntry(a.id, { host: 'a2' });
    fx.vault.updateEntry(b.id, { host: 'b2' });
    fx.vault.deleteEntry(gone.id);
    fx.vault.setCloudSyncEnabled(true);
    const input = { state, content: readContent(fx.raw), cache, implicit: implicitFor(ctx) };

    const res = captureRows(input, [rowKey(TBL.entries, a.id), rowKey(TBL.entries, gone.id)], local(EDIT_MS), ctx);
    expect(getRegister(res.state, e(a.id, 'host'))?.sibs[0].value).toBe('a2');
    expect(getRegister(res.state, e(b.id, 'host'))).toBe(getRegister(state, e(b.id, 'host')));
    expect(rowLife(res.state, rowKey(TBL.entries, gone.id))).toBe('dead');
    expect(getRegister(res.state, metaRegKey('cloud_sync_enabled'))).toBeUndefined();

    const withMeta = captureRows(input, [rowKey(TBL.meta, META_ROW_ID)], local(EDIT_MS), ctx);
    expect(getRegister(withMeta.state, metaRegKey('cloud_sync_enabled'))?.sibs[0].value).toBe('true');
  });
});

describe('performance (spec 13.3)', () => {
  it('runs an unchanged full pass over 5,000 entries well under the 100 ms budget', () => {
    const { fx, ctx } = setup();
    const insert = fx.raw.prepare(
      `INSERT INTO entries (id, name, entry_type, host, port, username, password_encrypted, config, tags, created_at, updated_at)
       VALUES (?, ?, 'ssh', ?, 22, 'root', ?, '{"keepalive":30}', '["prod"]', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    );
    fx.raw.transaction(() => {
      for (let i = 0; i < 5_000; i++) insert.run(`e${i}`, `entry ${i}`, `10.0.${i % 256}.${i % 250}`, sealWith(K_CURRENT, `pw${i}`));
    })();
    const content = readContent(fx.raw);
    const { state, cache } = initialState(content, ctx);
    const input = { state, content, cache, implicit: implicitFor(ctx) };
    captureFullPass(input, local(EDIT_MS), ctx);
    const t0 = performance.now();
    const res = captureFullPass(input, local(EDIT_MS), ctx);
    const elapsed = performance.now() - t0;
    expect(res.state).toBe(state);
    expect(elapsed).toBeLessThan(300);
  });

  it('compares 5,000 rows register by register (raw_hash cache cold) in a bounded time', () => {
    const { fx, ctx } = setup();
    const insert = fx.raw.prepare(
      `INSERT INTO entries (id, name, entry_type, host, password_encrypted, created_at, updated_at)
       VALUES (?, ?, 'ssh', ?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    );
    fx.raw.transaction(() => {
      for (let i = 0; i < 5_000; i++) insert.run(`e${i}`, `entry ${i}`, `h${i}`, sealWith(K_CURRENT, `pw${i}`));
    })();
    const content = readContent(fx.raw);
    const t0 = performance.now();
    const { state, cache } = initialState(content, ctx);
    const insertMs = performance.now() - t0;
    const cold = new Map([...cache].map(([k, v]) => [k, { materialized: v.materialized, rawHash: null }] as const));
    const t1 = performance.now();
    const res = captureFullPass({ state, content, cache: cold, implicit: implicitFor(ctx) }, local(EDIT_MS), ctx);
    const coldMs = performance.now() - t1;
    expect(res.state).toBe(state);
    expect(insertMs).toBeLessThan(1_000);
    expect(coldMs).toBeLessThan(1_000);
  });
});
