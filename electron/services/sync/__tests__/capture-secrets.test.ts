// @vitest-environment node
// Review findings on secrets across key epochs (spec 4.8): a stale-key legacy write of an
// unchanged secret (finding 7), held secret changes applied after a password change
// (finding 8) and the stale-revert rule for secrets after a password change (finding 9).
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decrypt } from '../../vault/crypto.js';
import { applyHeld, captureLegacy } from '../capture-legacy.js';
import { captureFullPass } from '../capture-local.js';
import { regKey } from '../catalog.js';
import { makeImplicitProvider, vhashOfSecret } from '../hashing.js';
import { readSecret } from '../key-epoch.js';
import { getRegister, provisional, recoveryFrom } from '../state-view.js';
import { loadFile } from '../state-store.js';
import { TBL, type KeyRing, type SyncState } from '../types.js';
import { NEW_PASSWORD, entryRow } from './core-e2e-fixtures.js';
import {
  DEV_A,
  K_CURRENT,
  K_OLDER,
  createVault,
  dot,
  epochKeys,
  implicitFor,
  initialState,
  legacyAtt,
  makeCtx,
  readContent,
  ringOf,
  sealWith,
  simulateLoad,
  type VaultFixture,
} from './capture-fixtures.js';
import { advance, rawShared, setupWorld, teardownWorld, type World } from './sim-world.js';

let w: World | null = null;
let fx: VaultFixture | null = null;
afterEach(() => {
  teardownWorld(w);
  w = null;
  fx?.close();
  fx = null;
});

const NONCE_LEN = 12;
const pwKey = (id: string) => regKey(TBL.entries, id, 'password');

/** AES-256-GCM in the vault format (nonce | ct | tag); a zero nonce makes the bytes sort first. */
function sealUnder(key: Buffer, plain: string, nonce: Buffer = crypto.randomBytes(NONCE_LEN)): Buffer {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

function plaintexts(state: SyncState, id: string, ring: KeyRing): string[] {
  return (getRegister(state, pwKey(id))?.sibs ?? []).map((s) => {
    const read = readSecret(s.value as Uint8Array, ring);
    return read.kind === 'undecryptable' ? '?' : read.plaintext;
  });
}

/** An older app still holding K1 saves the entry: password bytes under K1, a newer updated_at. */
function staleKeySave(world: World, id: string, plain: string, extra: { host?: string } = {}, nonce?: Buffer): void {
  const bytes = sealUnder(world.fixture.source.key, plain, nonce);
  const host = extra.host ?? null;
  const sql = 'UPDATE entries SET password_encrypted = ?, host = COALESCE(?, host), updated_at = ? WHERE id = ?';
  rawShared(world, sql, bytes, host, new Date(world.now).toISOString(), id);
}

describe('finding 7: stale-key legacy secret with unchanged plaintext', () => {
  const ctx = makeCtx({ keys: ringOf(epochKeys(K_CURRENT), epochKeys(K_OLDER)) });
  const EDIT_MS = 2_000;

  /** The entry's password rewritten under the older ring key, plaintext unchanged. */
  function staleKeyVault() {
    fx = createVault(K_CURRENT);
    const id = fx.vault.createEntry({ name: 'S', entry_type: 'ssh', password: 'pw' }).id;
    const pub = initialState(readContent(fx.raw), ctx);
    fx.raw.prepare('UPDATE entries SET password_encrypted = ? WHERE id = ?').run(sealWith(K_OLDER, 'pw'), id);
    const content = readContent(fx.raw);
    return { id, pub, content, x: simulateLoad(pub.state, content, pub.cache) };
  }

  function opensUnderCurrent(state: SyncState, id: string): string {
    const sibs = getRegister(state, pwKey(id))!.sibs;
    expect(sibs).toHaveLength(1);
    return decrypt(Buffer.from(sibs[0].value as Uint8Array), K_CURRENT).toString('utf8');
  }

  it('legacy capture re-seals the head value without a new sibling and asks for a content repair', () => {
    const { id, pub, content, x } = staleKeyVault();
    const res = captureLegacy({ state: x, content, cache: pub.cache, implicit: implicitFor(ctx) }, legacyAtt(ctx), ctx);
    expect(opensUnderCurrent(res.state, id)).toBe('pw');
    expect(getRegister(res.state, pwKey(id))!.sibs[0].vhash).toBe(getRegister(pub.state, pwKey(id))!.sibs[0].vhash);
    expect(res.stats).toMatchObject({ legacyEdits: 0, legacyDeletes: 0, staleReverts: 0 });
    expect(res.contentRepairNeeded).toBe(true);
  });

  it('local capture re-seals it too, with no dot', () => {
    const { id, pub, content, x } = staleKeyVault();
    const input = { state: x, content, cache: pub.cache, implicit: implicitFor(ctx) };
    const res = captureFullPass(input, { kind: 'local', dot: dot(DEV_A, EDIT_MS), interactive: false }, ctx);
    expect(opensUnderCurrent(res.state, id)).toBe('pw');
    expect(res.state.vv).toBe(x.vv);
    expect(res.stats.appWrites).toBe(0);
  });

  it('re-encrypts it under the current key before it can reach W', () => {
    w = setupWorld();
    const { a } = w;
    const { web } = w.fixture.ids;
    advance(w);
    a.changePassword(NEW_PASSWORD);
    advance(w);
    a.publish(w.shared);
    advance(w);
    staleKeySave(w, web, 'pw-web', { host: '10.0.0.9' }, Buffer.alloc(NONCE_LEN));
    advance(w);
    expect(a.sync(w.shared).kind).toBe('merged');
    const row = entryRow(a.db, web) as { host: string; password_encrypted: Buffer };
    expect(row.host).toBe('10.0.0.9');
    expect(decrypt(Buffer.from(row.password_encrypted), a.keys.current.kEpoch).toString('utf8')).toBe('pw-web');
    expect(a.fullPass()).toBe(false);
    expect(a.vault.getEntry(web)?.password).toBe('pw-web');
  });
});

describe('finding 9: stale revert of a secret after a password change', () => {
  it('keeps the newer password as a conflict when an older app writes back the previous one', () => {
    w = setupWorld();
    const { a } = w;
    const { web } = w.fixture.ids;
    advance(w);
    a.edit((v) => v.updateEntry(web, { password: 'pw-new' }), true);
    advance(w);
    a.changePassword(NEW_PASSWORD);
    advance(w);
    a.publish(w.shared);
    advance(w);
    staleKeySave(w, web, 'pw-web');
    advance(w);
    a.sync(w.shared);
    expect(plaintexts(a.state, web, a.keys).sort()).toEqual(['pw-new', 'pw-web']);
  });
});

describe('finding 8: held secret changes applied after a password change', () => {
  it('moves the held sibling to the current epoch (ciphertext and keyed vhash)', () => {
    w = setupWorld();
    const { a } = w;
    const { web } = w.fixture.ids;
    advance(w);
    a.edit((v) => v.updateEntry(web, { password: 'pw-new' }));
    advance(w);
    a.publish(w.shared);
    advance(w);
    staleKeySave(w, web, 'pw-web');
    const sdb = new Database(w.shared, { readonly: true });
    const file = loadFile(sdb);
    sdb.close();
    const e1 = a.keys.current;
    const att = {
      kind: 'legacy',
      observedMtimeMs: w.now,
      sideFilesPresent: true,
      serverSideFilesFlagRecent: false,
      absorbKeys: e1,
      sourceSha256: 'ab'.repeat(32),
      recover: recoveryFrom(a.state),
    } as const;
    const cap = captureLegacy({ state: file.state, content: file.content, cache: file.cache, implicit: a.implicit }, att, a.ctx);
    expect(cap.held.map((h) => [h.kind, h.key.reg])).toEqual([['stale-revert', 'password']]);
    advance(w);
    a.changePassword(NEW_PASSWORD);
    const e2 = a.keys.current;
    const applied = applyHeld(a.state, cap.held, makeImplicitProvider(e2.kSync), a.ctx);
    const prov = provisional('password', getRegister(applied.state, pwKey(web))!.sibs)!;
    expect(prov.dev).toBe(0);
    expect(decrypt(Buffer.from(prov.value as Uint8Array), e2.kEpoch).toString('utf8')).toBe('pw-web');
    expect(prov.vhash).toBe(vhashOfSecret(pwKey(web), 'pw-web', e2.kSync));
    expect(prov.pid).toBe(cap.held[0].sibling.pid);
  });
});
