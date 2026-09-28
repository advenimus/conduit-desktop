// @vitest-environment node
// Capture against files written and read by the real state-store and materialize: the loaded
// head values (including the ones the loader cannot trust) are exactly what capture receives.
import { afterEach, describe, expect, it } from 'vitest';
import { captureFullPass } from '../capture-local.js';
import { captureLegacy } from '../capture-legacy.js';
import { LIFE_DEAD, regKey, rowKey } from '../catalog.js';
import { materialize } from '../materialize.js';
import { ensureSyncSchema } from '../schema.js';
import { getRegister, headOf, recoveryFrom, rowLife } from '../state-view.js';
import { loadContent, loadFile, saveState } from '../state-store.js';
import { TBL, type RowCache, type SyncState } from '../types.js';
import {
  DEV_A,
  MTIME_MS,
  createVault,
  dot,
  implicitFor,
  initialState,
  iosSaveEntry,
  legacyAtt,
  makeCtx,
  type VaultFixture,
} from './capture-fixtures.js';

const ctx = makeCtx();
const implicit = implicitFor(ctx);
const ek = (id: string, reg: string) => regKey(TBL.entries, id, reg);
const T_EDIT = Date.parse('2026-09-24T10:00:00.000Z');

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

/** Materializes a published state over the file's content and saves content plus sync tables. */
function publishToFile(v: VaultFixture, pub: { readonly state: SyncState; readonly cache: RowCache }): SyncState {
  ensureSyncSchema(v.raw);
  const m = materialize(pub.state, loadContent(v.raw), pub.cache, { implicit, currentEpoch: null });
  saveState(v.raw, { state: m.state, plan: m.plan, cache: m.cache, baseline: null });
  return m.state;
}

function seed(v: VaultFixture) {
  const folder = v.vault.createFolder({ name: 'Servers' });
  const ssh = v.vault.createEntry({
    name: 'web', entry_type: 'ssh', folder_id: folder.id, host: '10.0.0.1', port: 22,
    username: 'root', password: 'pw', tags: ['prod'], config: { keepalive: 30 },
  });
  const rdp = v.vault.createEntry({ name: 'rdp', entry_type: 'rdp', config: { resolution: '1080p', sharedFolders: ['/tmp'] } });
  const gone = v.vault.createEntry({ name: 'gone', entry_type: 'ssh', host: 'old-host', password: 'secret' });
  const hid = v.vault.recordPasswordHistory(gone.id, 'root', 'older', 'user');
  v.vault.getVaultId();
  return { folder, ssh, rdp, gone, hid };
}

describe('capture over state-store round trips', () => {
  it('a loaded file whose content matches its tables captures as unchanged', () => {
    fx = createVault();
    seed(fx);
    const first = initialState(loadContent(fx.raw), ctx);
    publishToFile(fx, first);
    const file = loadFile(fx.raw);
    const res = captureFullPass(
      { state: file.state, content: file.content, cache: file.cache, implicit },
      { kind: 'local', dot: dot(DEV_A, 9_000), interactive: false },
      ctx,
    );
    expect(res.changed).toBe(false);
    expect(res.state).toBe(file.state);
  });

  it('absorbs legacy edits, drops and deletes from a file loaded by state-store', () => {
    fx = createVault();
    const { ssh, rdp, gone, hid } = seed(fx);
    const published = publishToFile(fx, initialState(loadContent(fx.raw), ctx));
    iosSaveEntry(fx.raw, ssh.id, { host: '10.0.0.2' }, T_EDIT);
    iosSaveEntry(fx.raw, rdp.id, { config: '{"sharedFolders":[]}' }, T_EDIT);
    fx.vault.deleteEntry(gone.id);

    const file = loadFile(fx.raw);
    const att = legacyAtt(ctx, { recover: recoveryFrom(published) });
    const res = captureLegacy({ state: file.state, content: file.content, cache: file.cache, implicit }, att, ctx);

    expect(getRegister(res.state, ek(ssh.id, 'host'))!.sibs.map((s) => [s.dev, s.value])).toEqual([[0, '10.0.0.2']]);
    expect(getRegister(res.state, ek(gone.id, '_life'))!.sibs.map((s) => [s.ms, s.value])).toEqual([[MTIME_MS, LIFE_DEAD]]);
    expect(rowLife(res.state, rowKey(TBL.history, hid))).toBe('live');
    for (const key of [ek(gone.id, 'host'), ek(gone.id, 'password'), regKey(TBL.history, hid, 'password')]) {
      expect(headOf(key.reg, getRegister(res.state, key)!.sibs)?.value).toEqual(headOf(key.reg, getRegister(published, key)!.sibs)?.value);
    }
    expect(res.stats).toMatchObject({ legacyEdits: 1, legacyDeletes: 1, legacyDropped: 2 });
    expect(res.contentRepairNeeded).toBe(true);
    expect(res.notices.map((n) => n.kind)).toEqual(['dropped-setting', 'dropped-setting']);

    const m = materialize(res.state, file.content, file.cache, { implicit, currentEpoch: null });
    const repaired = m.plan.upsertEntries.find((row) => row.id === rdp.id);
    expect(JSON.parse(String(repaired?.config))).toEqual({ resolution: '1080p', sharedFolders: ['/tmp'] });
    expect(m.plan.deleteEntries).toEqual([]);
  });
});
