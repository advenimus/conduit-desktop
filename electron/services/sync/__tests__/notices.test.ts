// @vitest-environment node
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { NOTICE_MAX_KEPT, Notices, ReminderRegistry, capNewest, noticeDedupeKey } from '../notices.js';
import { defaultLocalJson, readLocalJson, writeLocalJson } from '../local-state.js';
import { nodeRandom } from '../host-node.js';
import { FakeClock, MemoryLogger, RecordingEmitter, makeTempRoot } from './host-fakes.js';
import type { SyncEventMap } from '../host.js';
import type { LocalJson, LocalNotice, RegKey } from '../types.js';

const LINEAGE = '11111111-2222-4333-8444-555555555555';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const KEY: RegKey = { tbl: 1, rowId: 'e1', reg: 'config.color' };

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** local.json on disk, like the replica keeps it. */
function setup() {
  const dir = makeTempRoot('notices');
  roots.push(dir);
  let local: LocalJson = defaultLocalJson(LINEAGE, 42, 'c'.repeat(32));
  writeLocalJson(dir, local);
  let writes = 0;
  const replica = {
    lineageId: LINEAGE,
    local: () => local,
    updateLocal: (fn: (l: LocalJson) => LocalJson) => {
      local = fn(local);
      writeLocalJson(dir, local);
      writes += 1;
      return local;
    },
  };
  const clock = new FakeClock();
  const events = new RecordingEmitter<SyncEventMap>();
  const logger = new MemoryLogger();
  const reminders = new ReminderRegistry();
  const notices = new Notices({ replica, host: { clock, random: nodeRandom, events, logger }, reminders });
  return { dir, notices, clock, events, logger, writes: () => writes, reminders, replica };
}

describe('Notices', { timeout: 30_000 }, () => {
  it('persists, emits, and dedupes by (kind, key, source)', () => {
    const t = setup();
    const n = t.notices.add({ kind: 'dropped-setting', key: KEY, sourceSha256: SHA_A, count: 1 });
    expect(n).not.toBeNull();
    expect(t.notices.add({ kind: 'dropped-setting', key: KEY, sourceSha256: SHA_A, count: 5 })).toBeNull();
    expect(t.notices.add({ kind: 'dropped-setting', key: KEY, sourceSha256: SHA_B, count: 1 })).not.toBeNull();
    expect(t.notices.add({ kind: 'mass-change', key: null, sourceSha256: SHA_A, count: 42 })).not.toBeNull();
    expect(t.writes()).toBe(3);
    const onDisk = readLocalJson(t.dir, t.clock.now()).value;
    expect(onDisk?.notices.map((x) => x.kind)).toEqual(['dropped-setting', 'dropped-setting', 'mass-change']);
    const emitted = t.events.of('sync:notice');
    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => e.persisted && e.lineageId === LINEAGE)).toBe(true);
    expect(n?.createdMs).toBe(t.clock.now());
  });

  it('addFromCapture keeps core ids unless they collide, dedupes within the batch, one write', () => {
    const t = setup();
    const first = t.notices.add({ kind: 'invariant-repair', key: null, sourceSha256: null, count: 1 });
    const core: LocalNotice[] = [
      { id: `undecryptable-secrets:${SHA_A}:*`, kind: 'undecryptable-secrets', key: null, createdMs: 5, sourceSha256: SHA_A, count: 2 },
      { id: `undecryptable-secrets:${SHA_A}:*`, kind: 'undecryptable-secrets', key: null, createdMs: 5, sourceSha256: SHA_A, count: 2 },
      { id: first?.id ?? '', kind: 'value-unrecoverable', key: KEY, createdMs: 6, sourceSha256: SHA_B, count: 1 },
    ];
    const writesBefore = t.writes();
    const added = t.notices.addFromCapture(core);
    expect(t.writes()).toBe(writesBefore + 1);
    expect(added).toHaveLength(2);
    expect(added[0]?.id).toBe(`undecryptable-secrets:${SHA_A}:*`);
    expect(added[1]?.id).not.toBe(first?.id);
    expect(new Set(t.notices.list().map((n) => n.id)).size).toBe(3);
    expect(t.notices.addFromCapture(core)).toEqual([]);
    expect(t.writes()).toBe(writesBefore + 1);
  });

  it('keeps only the newest NOTICE_MAX_KEPT', async () => {
    const t = setup();
    for (let i = 0; i < NOTICE_MAX_KEPT + 5; i++) {
      await t.clock.advance(1);
      t.notices.add({ kind: 'dropped-setting', key: { ...KEY, rowId: `e${i}` }, sourceSha256: null, count: 1 });
    }
    const list = t.notices.list();
    expect(list).toHaveLength(NOTICE_MAX_KEPT);
    expect(list[0]?.key?.rowId).toBe('e5');
  });

  it('capNewest drops by age and keeps the survivors in order', () => {
    const mk = (id: string, createdMs: number): LocalNotice => ({ id, kind: 'mass-change', key: null, createdMs, sourceSha256: null, count: 1 });
    expect(capNewest([mk('a', 3), mk('b', 1), mk('c', 2)], 2).map((n) => n.id)).toEqual(['a', 'c']);
    expect(noticeDedupeKey(mk('x', 1))).toBe(noticeDedupeKey(mk('y', 9)));
  });

  it('dismiss removes and reports; unknown ids write nothing', () => {
    const t = setup();
    const n = t.notices.add({ kind: 'mass-change', key: null, sourceSha256: SHA_A, count: 12 });
    const w = t.writes();
    expect(t.notices.dismiss('nope')).toBe(false);
    expect(t.writes()).toBe(w);
    expect(t.notices.dismiss(n?.id ?? '')).toBe(true);
    expect(t.notices.list()).toEqual([]);
  });

  it('toasts are emitted, never persisted', () => {
    const t = setup();
    const toast = t.notices.toast('copy-merged', { name: 'Vault-HOST.conduit', provider: 'onedrive' });
    expect(toast).toMatchObject({ kind: 'copy-merged', params: { name: 'Vault-HOST.conduit' } });
    expect(t.writes()).toBe(0);
    expect(t.events.last('sync:notice')).toEqual({ lineageId: LINEAGE, persisted: false, notice: toast });
  });

  it('remindDue throttles per key and lineage in memory', async () => {
    const t = setup();
    const day = 24 * 60 * 60 * 1000;
    expect(t.notices.remindDue('side-files', day)).toBe(true);
    expect(t.notices.remindDue('side-files', day)).toBe(false);
    expect(t.notices.remindDue('network-root', day)).toBe(true);
    await t.clock.advance(day);
    expect(t.notices.remindDue('side-files', day)).toBe(true);
    const other = new Notices({
      replica: { ...t.replica, lineageId: '99999999-2222-4333-8444-555555555555' },
      host: { clock: t.clock, random: nodeRandom, events: t.events, logger: t.logger },
      reminders: t.reminders,
    });
    expect(other.remindDue('side-files', day)).toBe(true);
  });

  it('rejects invalid counts and logs a failing local.json write before rethrowing', () => {
    const t = setup();
    expect(() => t.notices.add({ kind: 'mass-change', key: null, sourceSha256: null, count: -1 })).toThrow(/\[sync\]/);
    const logger = new MemoryLogger();
    const failing = new Notices({
      replica: {
        lineageId: LINEAGE,
        local: () => defaultLocalJson(LINEAGE, 1, 'c'.repeat(32)),
        updateLocal: () => {
          throw new Error('disk full');
        },
      },
      host: { clock: t.clock, random: nodeRandom, events: t.events, logger },
    });
    expect(() => failing.add({ kind: 'mass-change', key: null, sourceSha256: null, count: 1 })).toThrow('disk full');
    expect(logger.messages('error')).toEqual(['[sync] notices: local.json write failed']);
    expect(logger.unprefixed()).toEqual([]);
  });
});
