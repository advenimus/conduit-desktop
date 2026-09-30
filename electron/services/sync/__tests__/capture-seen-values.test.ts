// @vitest-environment node
// A write that replaces "the provisional sibling it saw" also replaces every sibling holding
// that same value (spec 4.2 step 5, 4.3 rule 4): the writer has seen them, and a leftover
// equal-valued sibling would turn a plain delete into an edit-versus-delete conflict.
import { afterEach, describe, expect, it } from 'vitest';
import { applyLocalWrites, captureFullPass, prepareWrite } from '../capture-local.js';
import { applyHeld, captureLegacy } from '../capture-legacy.js';
import { LIFE_DEAD, LIFE_LIVE, regKey, rowKey } from '../catalog.js';
import { vhashOfValue } from '../hashing.js';
import { checkInvariants, merge } from '../merge.js';
import { identityKey } from '../sibling.js';
import { StateBuilder, getRegister, makeRegister, recoveryFrom, rowLife } from '../state-view.js';
import { TBL, type LegacyAttribution, type RegKey, type RowCache, type Sibling, type SyncState } from '../types.js';
import {
  DEV_A,
  DEV_B,
  cacheFor,
  createVault,
  dot,
  implicitFor,
  initialState,
  iosSaveEntry,
  legacyAtt,
  makeCtx,
  readContent,
  simulateLoad,
  type VaultFixture,
} from './capture-fixtures.js';

const DEV_C = 303;
const INIT_MS = 1_000;
const B_MS = 500;
const C_MS = 400;
const EDIT_MS = 5_000;
const T_LEGACY_EDIT = Date.parse('2026-09-24T10:00:00.000Z');
const ctx = makeCtx();
const implicit = implicitFor(ctx);
const ek = (id: string, reg: string) => regKey(TBL.entries, id, reg);
const fk = (id: string, reg: string) => regKey(TBL.folders, id, reg);

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

interface Published {
  readonly state: SyncState;
  readonly cache: RowCache;
}

function appSib(dev: number, ms: number, key: RegKey, value: string): Sibling {
  return { dev, ms, c: 0, pid: '', lt: 0, vhash: vhashOfValue(key, value), flags: 0, value, prevVhash: null };
}

/** Another device's earlier sibling, merged in: added to the register and covered by vv. */
function withSibling(state: SyncState, key: RegKey, extra: Sibling): SyncState {
  const b = new StateBuilder(state);
  const reg = getRegister(state, key);
  b.setRegister(makeRegister(key, [...(reg?.sibs ?? []), extra], reg?.pmem ?? null));
  b.joinVv(extra.dev, { ms: extra.ms, c: extra.c });
  return b.build();
}

function values(state: SyncState, key: RegKey): Array<[number, unknown]> {
  return getRegister(state, key)!.sibs.map((s) => [s.dev, s.value]);
}

function expectInvariants(state: SyncState): void {
  const rep = checkInvariants(state);
  expect(rep.uncoveredApp.length + rep.uncoveredPseudo.length + rep.nonCanonical.length).toBe(0);
}

function absorb(v: VaultFixture, pub: Published, overrides: Partial<LegacyAttribution> = {}) {
  const content = readContent(v.raw);
  const x = simulateLoad(pub.state, content, pub.cache);
  const att = legacyAtt(ctx, { recover: recoveryFrom(pub.state), ...overrides });
  return captureLegacy({ state: x, content, cache: pub.cache, implicit }, att, ctx);
}

describe('non-interactive local writes (4.2 step 5)', () => {
  it('a recursive folder delete kills rows another device re-asserted earlier (no edit-delete conflict)', () => {
    fx = createVault();
    const folder = fx.vault.createFolder({ name: 'F' });
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', folder_id: folder.id });
    const init = initialState(readContent(fx.raw), ctx, INIT_MS);
    const eLife = ek(ent.id, '_life');
    const fLife = fk(folder.id, '_life');
    const seen = withSibling(withSibling(init.state, eLife, appSib(DEV_B, B_MS, eLife, LIFE_LIVE)), fLife, appSib(DEV_B, B_MS, fLife, LIFE_LIVE));
    fx.vault.deleteFolder(folder.id);

    const input = { state: seen, content: readContent(fx.raw), cache: init.cache, implicit };
    const res = captureFullPass(input, { kind: 'local', dot: dot(DEV_A, EDIT_MS), interactive: false }, ctx);
    expect(rowLife(res.state, rowKey(TBL.entries, ent.id))).toBe('dead');
    expect(rowLife(res.state, rowKey(TBL.folders, folder.id))).toBe('dead');
    expect(values(res.state, eLife)).toEqual([[DEV_A, LIFE_DEAD]]);
    expect(values(res.state, fLife)).toEqual([[DEV_A, LIFE_DEAD]]);
    expectInvariants(res.state);
    const merged = merge(seen, res.state, implicit).state;
    expect(values(merged, eLife)).toEqual([[DEV_A, LIFE_DEAD]]);
  });

  it('an MCP write replaces every sibling equal to the provisional one and keeps the rest of a conflict', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh', host: 'x' });
    const init = initialState(readContent(fx.raw), ctx, INIT_MS);
    const host = ek(ent.id, 'host');
    const state = withSibling(withSibling(init.state, host, appSib(DEV_B, B_MS, host, 'x')), host, appSib(DEV_C, C_MS, host, 'y'));
    const att = { kind: 'local', dot: dot(DEV_A, EDIT_MS), interactive: false } as const;

    const res = applyLocalWrites(state, [prepareWrite(host, { value: 'z' }, ctx)], att, ctx, implicit);
    expect(values(res.state, host)).toEqual([[DEV_A, 'z'], [DEV_C, 'y']]);
    expectInvariants(res.state);
  });

  it('an MCP delete of an entry two devices re-asserted leaves it dead', () => {
    fx = createVault();
    const ent = fx.vault.createEntry({ name: 'n', entry_type: 'ssh' });
    const init = initialState(readContent(fx.raw), ctx, INIT_MS);
    const life = ek(ent.id, '_life');
    const state = withSibling(init.state, life, appSib(DEV_B, B_MS, life, LIFE_LIVE));
    const att = { kind: 'local', dot: dot(DEV_A, EDIT_MS), interactive: false } as const;

    const res = applyLocalWrites(state, [prepareWrite(life, { value: LIFE_DEAD }, ctx)], att, ctx, implicit);
    expect(rowLife(res.state, rowKey(TBL.entries, ent.id))).toBe('dead');
    expect(values(res.state, life)).toEqual([[DEV_A, LIFE_DEAD]]);
  });
});

describe('legacy rule 4 and held changes (4.3)', () => {
  function twoDeviceEntry(fields: { name: string }) {
    fx = createVault();
    const ent = fx.vault.createEntry({ ...fields, entry_type: 'ssh' });
    const init = initialState(readContent(fx.raw), ctx, INIT_MS);
    const life = ek(ent.id, '_life');
    const name = ek(ent.id, 'name');
    const state = withSibling(withSibling(init.state, life, appSib(DEV_B, B_MS, life, LIFE_LIVE)), name, appSib(DEV_B, B_MS, name, fields.name));
    return { v: fx, ent, life, name, pub: { state, cache: cacheFor(readContent(fx.raw)) } };
  }

  it('a legacy delete of an entry two devices re-asserted leaves it dead', () => {
    const { v, ent, life, pub } = twoDeviceEntry({ name: 'foo' });
    v.raw.prepare('DELETE FROM entries WHERE id = ?').run(ent.id);
    const res = absorb(v, pub);
    expect(rowLife(res.state, rowKey(TBL.entries, ent.id))).toBe('dead');
    expect(values(res.state, life)).toEqual([[0, LIFE_DEAD]]);
    expectInvariants(res.state);
  });

  it('a legacy edit replaces the equal values of both devices instead of making a conflict', () => {
    const { v, ent, name, pub } = twoDeviceEntry({ name: 'foo' });
    iosSaveEntry(v.raw, ent.id, { name: 'bar' }, T_LEGACY_EDIT);
    const res = absorb(v, pub);
    expect(values(res.state, name)).toEqual([[0, 'bar']]);
    expectInvariants(res.state);
  });

  it('a held legacy delete, applied later, also replaces the equal-valued siblings the legacy app saw', () => {
    const { v, ent, life, pub } = twoDeviceEntry({ name: 'foo' });
    v.raw.prepare('DELETE FROM entries WHERE id = ?').run(ent.id);
    const res = absorb(v, pub, { sideFilesPresent: true });
    expect(res.held).toHaveLength(1);
    const b = getRegister(pub.state, life)!.sibs.find((s) => s.dev === DEV_B)!;
    expect(res.held[0].replacesEqual).toEqual([identityKey(b)]);

    const applied = applyHeld(res.state, res.held, implicit, ctx);
    expect(rowLife(applied.state, rowKey(TBL.entries, ent.id))).toBe('dead');
    expect(values(applied.state, life)).toEqual([[0, LIFE_DEAD]]);
  });

  it('applyHeld never removes an equal-valued sibling the legacy app did not see', () => {
    const { v, ent, life, pub } = twoDeviceEntry({ name: 'foo' });
    v.raw.prepare('DELETE FROM entries WHERE id = ?').run(ent.id);
    const res = absorb(v, pub, { sideFilesPresent: true });
    const later = withSibling(res.state, life, appSib(DEV_C, EDIT_MS, life, LIFE_LIVE));
    const applied = applyHeld(later, res.held, implicit, ctx);
    expect(values(applied.state, life)).toEqual([[0, LIFE_DEAD], [DEV_C, LIFE_LIVE]]);
  });
});
