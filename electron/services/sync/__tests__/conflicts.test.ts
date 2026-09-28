// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceRegKey, epochRegKey } from '../catalog.js';
import { deviceNamesFromPresence, hasConflict, listConflicts, revealSecret, snoozeKeyOf, type ConflictContext } from '../conflicts.js';
import { jcs } from '../canonical.js';
import { prevOf, vhashOfSecret, vhashUndecryptable } from '../hashing.js';
import { encryptSecret } from '../key-epoch.js';
import { identityKey } from '../sibling.js';
import { regKeyStr } from '../state-view.js';
import { SIB_UNDECRYPTABLE, TBL, type ConflictItem, type FieldConflict, type Sibling } from '../types.js';
import {
  app,
  entryKey,
  folderKey,
  implicitFor,
  keysFor,
  makeCtx,
  pseudo,
  ringOf,
  secretApp,
  seqRandom,
  stateOf,
  type RegSpec,
} from './conflicts-fixtures.js';

const K = keysFor('pw', 'salt-2');
const OLD = keysFor('old', 'salt-1');
const ctx = makeCtx(ringOf(K));
const PID_A = 'a1'.repeat(16);
const PID_B = 'b2'.repeat(16);
const seqBytes = seqRandom(77);

function cctxOf(extra: Partial<ConflictContext> = {}): ConflictContext {
  return {
    implicit: implicitFor(ctx),
    structural: [],
    snoozed: new Set(),
    candidateLabels: new Map(),
    repairedKeys: new Set(),
    ...extra,
  };
}

const presence = (name: string): string =>
  jcs({ platform: 'darwin', name, app_version: '1', first_seen_ms: 1, last_active_ms: 2, session_open: 0, session_since_ms: null, account_hint: null, file_hint: null, side_files_seen_ms: null });

function kinds(items: readonly ConflictItem[]): string[] {
  return items.map((i) => i.kind);
}

describe('snoozeKeyOf (7.4)', () => {
  it('hashes the register key and sorted identities, independent of sibling order', () => {
    const key = entryKey('e1', 'host');
    const a = app(key, 1, 5, 'x');
    const b = app(key, 2, 6, 'y');
    const expected = createHash('sha256')
      .update(Buffer.from(regKeyStr(key), 'utf8'))
      .update(Buffer.from([0x1f]))
      .update(Buffer.from([identityKey(a), identityKey(b)].sort().join('\u001f'), 'utf8'))
      .digest()
      .subarray(0, 16)
      .toString('hex');
    expect(snoozeKeyOf(key, [a, b])).toBe(expected);
    expect(snoozeKeyOf(key, [b, a])).toBe(expected);
    expect(snoozeKeyOf(key, [a])).not.toBe(expected);
  });
});

describe('deviceNamesFromPresence', () => {
  it('reads names from presence registers and skips malformed values', () => {
    const k1 = deviceRegKey('uuid-1');
    const k2 = deviceRegKey('uuid-2');
    const s = stateOf([
      { key: k1, sibs: [app(k1, 1, 1, presence('MacBook'))] },
      { key: k2, sibs: [app(k2, 2, 1, '{not json')] },
    ]);
    expect(deviceNamesFromPresence(s)).toEqual(new Map([['uuid-1', 'MacBook']]));
  });
});

describe('listConflicts (4.10, 7.2)', () => {
  const host = entryKey('e1', 'host');
  const name = entryKey('e1', 'name');
  const notes = entryKey('e1', 'notes');
  const password = entryKey('e1', 'password');
  const icon = entryKey('e1', 'icon');
  const tag = entryKey('e1', 'tag:prod');
  const sort = entryKey('e1', 'sort_order');
  const hostApp = app(host, 1, 10, '10.0.0.5', { prevVhash: app(host, 0, 0, '10.0.0.9').vhash.slice(0, 16) });
  const hostPseudo = pseudo(host, 12, PID_A, '10.0.0.9', 9);

  function richState(extraRegs: RegSpec[] = []): ReturnType<typeof stateOf> {
    const dev1 = deviceRegKey('uuid-1');
    return stateOf(
      [
        { key: name, sibs: [app(name, 1, 1, 'Prod')] },
        { key: host, sibs: [hostApp, hostPseudo], pmem: { ms: 12, ids: [PID_A] } },
        { key: notes, sibs: [app(notes, 1, 3, 'a'), app(notes, 2, 4, 'b')] },
        { key: password, sibs: [secretApp(password, 1, 5, 'p1', K), secretApp(password, 2, 6, 'p2', K)] },
        { key: icon, sibs: [app(icon, 1, 7, 'star'), app(icon, 2, 8, 'moon')] },
        { key: tag, sibs: [app(tag, 1, 7, 1), app(tag, 3, 9, null)] },
        { key: sort, sibs: [app(sort, 1, 7, 1), app(sort, 2, 8, 2)] },
        { key: dev1, sibs: [app(dev1, 1, 1, presence('MacBook'))] },
        ...extraRegs,
      ],
      (b) => {
        b.addDev({ dev: 1, deviceUuid: 'uuid-1', startedMs: 0 });
        b.addDev({ dev: 2, deviceUuid: 'uuid-2', startedMs: 0 });
      },
    );
  }

  it('lists field, secret, notes and appearance items for one entry; auto registers never conflict', () => {
    const groups = listConflicts(richState(), cctxOf({ candidateLabels: new Map([[3, 'Vault 2.conduit']]) }));
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.title).toBe('Prod');
    expect(kinds(g.items)).toEqual(['field', 'field', 'field', 'appearance']);
    const fields = g.items.flatMap((i) => (i.kind === 'field' ? [i.field] : []));
    expect(fields.map((f) => f.key.reg)).toEqual(['host', 'notes', 'password']);

    const [hostField, notesField, pwField] = fields;
    expect(hostField.staleRevert).toBe(true);
    expect(hostField.versions.map((v) => v.id)).toEqual([identityKey(hostPseudo), identityKey(hostApp)]);
    expect(hostField.versions[0].source).toEqual({ kind: 'older-app' });
    expect(hostField.versions[0].timeMs).toBe(9);
    expect(hostField.versions[0].provisional).toBe(true);
    expect(hostField.versions[1].source).toEqual({ kind: 'device', deviceUuid: 'uuid-1', deviceName: 'MacBook' });
    expect(notesField.keepBothOffered).toBe(true);
    expect(hostField.keepBothOffered).toBe(false);
    expect(pwField.secret).toBe(true);
    expect(pwField.versions.every((v) => v.masked && v.value === null)).toBe(true);

    const appearance = g.items[3];
    if (appearance.kind !== 'appearance') throw new Error('expected appearance');
    expect(appearance.fields.map((f) => f.key.reg)).toEqual(['icon', 'tag:prod']);
    expect(appearance.newest.get('icon')).toBe('a:2:8:0');
    expect(appearance.newest.get('tag:prod')).toBe('a:3:9:0');
    expect(appearance.fields[1].versions[0].source).toEqual({ kind: 'candidate', label: 'Vault 2.conduit' });
  });

  it('marks invariant-guard fields and snoozes a group only when every item is snoozed', () => {
    const s = richState();
    const first = listConflicts(s, cctxOf({ repairedKeys: new Set([regKeyStr(host)]) }))[0];
    const hostItem = first.items[0];
    expect(hostItem.kind === 'field' && hostItem.field.invariantGuard).toBe(true);
    const keys = first.items.map((i) => (i.kind === 'field' ? i.field.snoozeKey : i.kind === 'appearance' ? i.snoozeKey : ''));
    expect(listConflicts(s, cctxOf({ snoozed: new Set(keys) }))[0].snoozed).toBe(true);
    expect(listConflicts(s, cctxOf({ snoozed: new Set(keys.slice(1)) }))[0].snoozed).toBe(false);
  });

  it('turns undecryptable siblings into undecryptable items', () => {
    const ct = Buffer.from('opaque-ciphertext');
    const bad: Sibling = { dev: 0, ms: 3, c: 0, pid: PID_B, lt: 3, vhash: vhashUndecryptable(ct), flags: SIB_UNDECRYPTABLE, value: ct, prevVhash: null };
    const pw = entryKey('e2', 'password');
    const s = stateOf([{ key: pw, sibs: [secretApp(pw, 1, 5, 'p1', K), bad], pmem: { ms: 3, ids: [PID_B] } }]);
    const items = listConflicts(s, cctxOf())[0].items;
    expect(kinds(items)).toEqual(['undecryptable']);
    const item = items[0];
    if (item.kind !== 'undecryptable') throw new Error('expected undecryptable');
    expect(item.field.versions.find((v) => v.undecryptable)?.provisional).toBe(false);
  });

  it('builds edit-delete and folder-delete items; a folder lists the live rows inside it', () => {
    const eLife = entryKey('e1', '_life');
    const fLife = folderKey('f1', '_life');
    const inside = entryKey('e5', 'container');
    const deep = folderKey('f2', 'container');
    const deeper = entryKey('e6', 'container');
    const s = stateOf([
      { key: eLife, sibs: [app(eLife, 1, 5, 'live'), app(eLife, 2, 6, 'dead')] },
      { key: fLife, sibs: [app(fLife, 1, 5, 'live'), app(fLife, 2, 6, 'dead')] },
      { key: inside, sibs: [app(inside, 1, 5, 'f:f1')] },
      { key: deep, sibs: [app(deep, 1, 5, 'f:f1')] },
      { key: deeper, sibs: [app(deeper, 1, 5, 'f:f2')] },
    ]);
    const groups = listConflicts(s, cctxOf());
    expect(groups.map((g) => g.row)).toEqual([
      { tbl: TBL.entries, rowId: 'e1' },
      { tbl: TBL.folders, rowId: 'f1' },
    ]);
    const ed = groups[0].items[0];
    if (ed.kind !== 'edit-delete') throw new Error('expected edit-delete');
    expect(ed.deleted.map((v) => v.dev)).toEqual([2]);
    expect(ed.edited.map((v) => v.dev)).toEqual([1]);
    const fd = groups[1].items[0];
    if (fd.kind !== 'folder-delete') throw new Error('expected folder-delete');
    expect(fd.changedItems).toEqual([
      { tbl: TBL.entries, rowId: 'e5' },
      { tbl: TBL.entries, rowId: 'e6' },
      { tbl: TBL.folders, rowId: 'f2' },
    ]);
  });

  it('skips provisionally dead items, and lists epoch and cycle conflicts', () => {
    const deadLife = entryKey('e9', '_life');
    const deadHost = entryKey('e9', 'host');
    const epoch = epochRegKey();
    const s = stateOf([
      { key: deadLife, sibs: [app(deadLife, 1, 5, 'dead')] },
      { key: deadHost, sibs: [app(deadHost, 1, 3, 'a'), app(deadHost, 2, 4, 'b')] },
      { key: epoch, sibs: [app(epoch, 1, 5, 'E2a'), app(epoch, 2, 6, 'E2b')] },
    ]);
    const cycle = { kind: 'cycle' as const, tbl: TBL.folders as 2, rowIds: ['x', 'y'], movedToRoot: 'y' };
    const groups = listConflicts(s, cctxOf({ structural: [cycle] }));
    expect(groups.map((g) => [g.row.tbl, g.title])).toEqual([
      [TBL.folders, ''],
      [TBL.sync, 'Master password'],
    ]);
    expect(groups[0].items).toEqual([{ kind: 'cycle', tbl: 2, rowIds: ['x', 'y'], movedToRoot: 'y' }]);
    expect(groups[0].snoozed).toBe(false);
    const epochItem = groups[1].items[0];
    expect(epochItem.kind === 'epoch' && epochItem.versions.map((v) => v.value)).toEqual(['E2b', 'E2a']);
  });

  it('labels a secret stale revert whose app prev was hashed under an epoch before a password change', () => {
    // w replaced 'p-old' while OLD was current; a legacy write-back of 'p-old' was absorbed, then
    // the password changed: vhashes moved to K, w's prev_vhash kept OLD's K_sync.
    const w = { ...secretApp(password, 1, 10, 'p-new', K), prevVhash: prevOf(vhashOfSecret(password, 'p-old', OLD.kSync)) };
    const back = { dev: 0, ms: 12, c: 0, pid: PID_B, lt: 12, flags: 0, prevVhash: null };
    const revert = { ...back, value: encryptSecret('p-old', K, seqBytes), vhash: vhashOfSecret(password, 'p-old', K.kSync) };
    const s = stateOf([{ key: password, sibs: [w, revert], pmem: { ms: 12, ids: [PID_B] } }]);
    const fieldOfPassword = (c: ConflictContext): FieldConflict => {
      const item = listConflicts(s, c)[0].items[0];
      if (item.kind !== 'field') throw new Error('expected a field item');
      return item.field;
    };
    expect(fieldOfPassword(cctxOf({ keys: ringOf(K, OLD) })).staleRevert).toBe(true);
    expect(fieldOfPassword(cctxOf()).staleRevert).toBe(false);
    const cleared = { ...back, value: null, vhash: vhashOfSecret(password, null, K.kSync) };
    const wCleared = { ...w, prevVhash: prevOf(vhashOfSecret(password, null, OLD.kSync)) };
    const s2 = stateOf([{ key: password, sibs: [wCleared, cleared], pmem: { ms: 12, ids: [PID_B] } }]);
    const item2 = listConflicts(s2, cctxOf({ keys: ringOf(K, OLD) }))[0].items[0];
    expect(item2.kind === 'field' && item2.field.staleRevert).toBe(true);
  });

  it('orders groups by (tbl, title, rowId)', () => {
    const regs: RegSpec[] = ['b', 'a', 'c'].map((id, i) => {
      const k = entryKey(`r${i}`, 'host');
      return { key: k, sibs: [app(k, 1, 1, 'x'), app(k, 2, 2, 'y')] };
    });
    const names: RegSpec[] = ['b', 'a', 'c'].map((title, i) => {
      const k = entryKey(`r${i}`, 'name');
      return { key: k, sibs: [app(k, 1, 1, title)] };
    });
    const groups = listConflicts(stateOf([...regs, ...names]), cctxOf());
    expect(groups.map((g) => g.title)).toEqual(['a', 'b', 'c']);
  });
});

describe('hasConflict and revealSecret', () => {
  it('reports prompt and group A conflicts only', () => {
    const host = entryKey('e1', 'host');
    const sort = entryKey('e2', 'sort_order');
    const s = stateOf([
      { key: host, sibs: [app(host, 1, 1, 'a'), app(host, 2, 2, 'b')] },
      { key: sort, sibs: [app(sort, 1, 1, 1), app(sort, 2, 2, 2)] },
    ]);
    expect(hasConflict(s, { tbl: TBL.entries, rowId: 'e1' }, implicitFor(ctx))).toBe(true);
    expect(hasConflict(s, { tbl: TBL.entries, rowId: 'e2' }, implicitFor(ctx))).toBe(false);
    expect(hasConflict(s, { tbl: TBL.entries, rowId: 'nope' }, implicitFor(ctx))).toBe(false);
  });

  it('reveals with the current key or a ring key, and never an unreadable or redacted value', () => {
    const pw = entryKey('e1', 'password');
    expect(revealSecret(secretApp(pw, 1, 1, 'hunter2', K), ctx.keys)).toBe('hunter2');
    const old = secretApp(pw, 1, 1, 'older', OLD);
    expect(revealSecret(old, ctx.keys)).toBeNull();
    expect(revealSecret(old, ringOf(K, OLD))).toBe('older');
    expect(revealSecret({ ...old, flags: 2, value: null }, ringOf(K, OLD))).toBeNull();
    expect(revealSecret(secretApp(pw, 1, 1, null, K), ctx.keys)).toBe('');
  });
});
