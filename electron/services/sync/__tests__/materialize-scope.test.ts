// @vitest-environment node
// Review finding 2: a per-operation capture (captureRows) followed by materialize must not
// overwrite rows that writers which skipped the hook changed (vault_meta writes, importers,
// rekey, MCP). Those rows stay untouched until the next full pass captures them (4.2 step 6).
import { afterEach, describe, expect, it } from 'vitest';
import { captureFullPass, captureRows } from '../capture-local.js';
import { META_ROW_ID, metaRegKey, regKey, rowKey } from '../catalog.js';
import { rawHash } from '../hashing.js';
import { materialize } from '../materialize.js';
import { provisionalValue, rowKeyStr, rowLife } from '../state-view.js';
import { applyWritePlan } from '../state-store.js';
import { TBL, type RowKey } from '../types.js';
import { DEV_A, createVault, dot, implicitFor, initialState, makeCtx, readContent, type VaultFixture } from './capture-fixtures.js';

const ctx = makeCtx();
const implicit = implicitFor(ctx);
const E = TBL.entries;
const OP_MS = 5_000;
const NEXT_MS = 6_000;

let fx: VaultFixture | null = null;
afterEach(() => {
  fx?.close();
  fx = null;
});

interface Scenario {
  readonly fx: VaultFixture;
  readonly ids: { readonly edited: string; readonly renamed: string; readonly deleted: string; readonly inserted: string };
  readonly res: ReturnType<typeof captureRows>;
  readonly cache: ReturnType<typeof initialState>['cache'];
}

/** One hooked edit (captured with captureRows) after four changes that skipped the hook. */
function scenario(): Scenario {
  const v = createVault();
  fx = v;
  const edited = v.vault.createEntry({ name: 'E1', entry_type: 'ssh', host: 'h1' }).id;
  const renamed = v.vault.createEntry({ name: 'E2', entry_type: 'ssh', host: 'h2' }).id;
  const deleted = v.vault.createEntry({ name: 'E4', entry_type: 'ssh' }).id;
  const pub = initialState(readContent(v.raw), ctx);
  v.raw.prepare('UPDATE entries SET name = ? WHERE id = ?').run('E2-renamed', renamed);
  v.raw.prepare('DELETE FROM entries WHERE id = ?').run(deleted);
  const inserted = v.vault.createEntry({ name: 'E3 imported', entry_type: 'ssh' }).id;
  v.vault.setCloudSyncEnabled(true);
  v.vault.updateEntry(edited, { name: 'E1-renamed' });
  const input = { state: pub.state, content: readContent(v.raw), cache: pub.cache, implicit };
  const res = captureRows(input, [rowKey(E, edited)], { kind: 'local', dot: dot(DEV_A, OP_MS), interactive: true }, ctx);
  return { fx: v, ids: { edited, renamed, deleted, inserted }, res, cache: pub.cache };
}

const ids = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);

describe('materialize after a per-operation capture (capturedRows)', () => {
  it('returns the capture scope from captureRows only', () => {
    const s = scenario();
    expect(s.res.scope).toEqual([rowKey(E, s.ids.edited)]);
    const full = captureFullPass({ state: s.res.state, content: readContent(s.fx.raw), cache: s.cache, implicit }, {
      kind: 'local',
      dot: dot(DEV_A, NEXT_MS),
      interactive: false,
    }, ctx);
    expect(full.scope).toBeUndefined();
  });

  it('leaves rows changed outside the hook untouched, and handles the captured row as usual', () => {
    const s = scenario();
    const content = readContent(s.fx.raw);
    const m = materialize(s.res.state, content, s.cache, { implicit, currentEpoch: null, capturedRows: s.res.scope });
    const { edited, renamed, deleted, inserted } = s.ids;
    expect(ids(m.plan.upsertEntries)).not.toContain(renamed);
    expect(ids(m.plan.upsertEntries)).not.toContain(deleted);
    expect(m.plan.deleteEntries).not.toContain(inserted);
    expect(m.plan.meta.size).toBe(0);
    expect(m.cache.get(rowKeyStr(rowKey(E, renamed)))).toBe(s.cache.get(rowKeyStr(rowKey(E, renamed))));
    expect(m.cache.get(rowKeyStr(rowKey(E, deleted)))).toBe(s.cache.get(rowKeyStr(rowKey(E, deleted))));
    expect(m.cache.has(rowKeyStr(rowKey(E, inserted)))).toBe(false);
    const editedRow = content.entries.get(edited)!;
    expect(m.cache.get(rowKeyStr(rowKey(E, edited)))).toEqual({ materialized: true, rawHash: rawHash(E, editedRow) });
  });

  it('lets the next full pass capture every change the hook missed (nothing is lost)', () => {
    const s = scenario();
    const m = materialize(s.res.state, readContent(s.fx.raw), s.cache, { implicit, currentEpoch: null, capturedRows: s.res.scope });
    s.fx.raw.transaction(() => applyWritePlan(s.fx.raw, m.plan))();
    const content = readContent(s.fx.raw);
    const full = captureFullPass({ state: m.state, content, cache: m.cache, implicit }, {
      kind: 'local',
      dot: dot(DEV_A, NEXT_MS),
      interactive: false,
    }, ctx);
    const { edited, renamed, deleted, inserted } = s.ids;
    const name = (id: string) => provisionalValue(full.state, regKey(E, id, 'name'), null);
    expect(name(edited)).toBe('E1-renamed');
    expect(name(renamed)).toBe('E2-renamed');
    expect(name(inserted)).toBe('E3 imported');
    expect(rowLife(full.state, rowKey(E, deleted))).toBe('dead');
    expect(provisionalValue(full.state, metaRegKey('cloud_sync_enabled'), null)).toBe('true');
    const changed = new Set(full.changedRows.map((r: RowKey) => rowKeyStr(r)));
    expect(changed.has(rowKeyStr(rowKey(E, edited)))).toBe(false);
    expect(changed.has(rowKeyStr(rowKey(TBL.meta, META_ROW_ID)))).toBe(true);
  });
});
