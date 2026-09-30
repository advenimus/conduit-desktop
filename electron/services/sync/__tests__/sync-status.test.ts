// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SyncStatusModel, statusKindFor, type StatusFacts } from '../sync-status.js';
import { FakeClock, MemoryLogger, RecordingEmitter } from './host-fakes.js';
import type { OtherCopyView, SyncEventMap, SyncPrompt, WaitingState } from '../host.js';

const LINEAGE = '11111111-2222-4333-8444-555555555555';

const BASE: StatusFacts = {
  cycleRunning: false,
  pauseReason: null,
  fileMissing: false,
  unreachable: false,
  pendingPublish: false,
  waiting: null,
  lastError: false,
};

const WAITING: WaitingState = { purpose: 'stale-file', devices: [], blocking: true, stopOffered: false, sinceMs: 1 };

function model() {
  const events = new RecordingEmitter<SyncEventMap>();
  const logger = new MemoryLogger();
  const status = new SyncStatusModel(LINEAGE, { events, clock: new FakeClock(), logger });
  return { status, events, logger };
}

describe('statusKindFor precedence', () => {
  it('waiting > paused > file-not-found > offline > syncing > error > pending > up-to-date', () => {
    const all: StatusFacts = {
      cycleRunning: true,
      pauseReason: 'side-files',
      fileMissing: true,
      unreachable: true,
      pendingPublish: true,
      waiting: WAITING,
      lastError: true,
    };
    expect(statusKindFor(all)).toBe('waiting');
    expect(statusKindFor({ ...all, waiting: null })).toBe('paused');
    expect(statusKindFor({ ...all, waiting: null, pauseReason: null })).toBe('file-not-found');
    expect(statusKindFor({ ...all, waiting: null, pauseReason: null, fileMissing: false })).toBe('offline');
    const noOffline = { ...all, waiting: null, pauseReason: null, fileMissing: false, unreachable: false };
    expect(statusKindFor(noOffline)).toBe('syncing');
    expect(statusKindFor({ ...noOffline, cycleRunning: false })).toBe('error');
    expect(statusKindFor({ ...noOffline, cycleRunning: false, lastError: false })).toBe('pending');
    expect(statusKindFor(BASE)).toBe('up-to-date');
  });
});

describe('SyncStatusModel', () => {
  it('starts up to date and emits nothing until something changes', () => {
    const { status, events } = model();
    expect(status.snapshot()).toMatchObject({ lineageId: LINEAGE, kind: 'up-to-date', prompts: [], otherCopies: [] });
    status.update({});
    status.update({ pendingPublish: false, cycleRunning: false });
    expect(events.of('sync:state-changed')).toHaveLength(0);
  });

  it('emits once per actual change, never duplicates', () => {
    const { status, events } = model();
    status.update({ cycleRunning: true });
    status.update({ cycleRunning: true });
    status.update({ cycleRunning: false, pendingPublish: true, unsyncedOps: 3 });
    status.update({ unsyncedOps: 3 });
    const kinds = events.of('sync:state-changed').map((s) => s.kind);
    expect(kinds).toEqual(['syncing', 'pending']);
    expect(status.snapshot().unsyncedOps).toBe(3);
  });

  it('an explicit undefined never clears a fact', () => {
    const { status } = model();
    status.update({ fileName: 'Vault.conduit', lastSyncedMs: 10 });
    status.update({ fileName: undefined, lastSyncedMs: undefined });
    expect(status.snapshot()).toMatchObject({ fileName: 'Vault.conduit', lastSyncedMs: 10 });
    status.update({ lastSyncedMs: null });
    expect(status.snapshot().lastSyncedMs).toBeNull();
  });

  it('upserts prompts by id in place and clears by id and by kind', () => {
    const { status, events } = model();
    const a: SyncPrompt = { kind: 'file-missing', id: 'file-missing', path: '/a/Vault.conduit' };
    const b: SyncPrompt = { kind: 'epoch-legacy', id: 'epoch-legacy' };
    const c1: SyncPrompt = { kind: 'candidate', id: 'candidate:1', candidateId: '1', label: 'Vault 2.conduit' };
    const c2: SyncPrompt = { kind: 'candidate', id: 'candidate:2', candidateId: '2', label: 'Vault 3.conduit' };
    status.setPrompt(a);
    status.setPrompt(b);
    status.setPrompt(c1);
    status.setPrompt(c2);
    status.setPrompt({ ...a, path: '/b/Vault.conduit' });
    expect(status.snapshot().prompts.map((p) => p.id)).toEqual(['file-missing', 'epoch-legacy', 'candidate:1', 'candidate:2']);
    expect(status.snapshot().prompts[0]).toMatchObject({ path: '/b/Vault.conduit' });
    const before = events.of('sync:state-changed').length;
    status.setPrompt({ ...a, path: '/b/Vault.conduit' });
    expect(events.of('sync:state-changed')).toHaveLength(before);
    status.clearPromptKind('candidate');
    status.clearPrompt('epoch-legacy');
    status.clearPrompt('not-there');
    expect(status.snapshot().prompts.map((p) => p.id)).toEqual(['file-missing']);
  });

  it('waiting and pause reasons drive the kind; other copies and badge are carried', () => {
    const { status } = model();
    const copy: OtherCopyView = { path: '/x/Vault 2.conduit', name: 'Vault 2.conduit', sha256: 'ab'.repeat(32), cls: 'nothing-new', changes: 0, deletions: 0 };
    status.update({ pauseReason: 'kill-switch' });
    expect(status.snapshot().kind).toBe('paused');
    status.setWaiting(WAITING);
    expect(status.snapshot().kind).toBe('waiting');
    status.setWaiting(null);
    status.update({ pauseReason: null, fileMissing: true });
    expect(status.snapshot().kind).toBe('file-not-found');
    status.setOtherCopies([copy]);
    status.setSessionBadge('offline-device-check');
    expect(status.snapshot()).toMatchObject({ otherCopies: [copy], sessionBadge: 'offline-device-check' });
  });

  it('conflict counts emit sync:conflicts-changed only when the count changes', () => {
    const { status, events } = model();
    status.setConflicts(0);
    status.setConflicts(2);
    status.setConflicts(2);
    status.setConflicts(1);
    expect(events.of('sync:conflicts-changed')).toEqual([
      { lineageId: LINEAGE, count: 2 },
      { lineageId: LINEAGE, count: 1 },
    ]);
    expect(status.snapshot().conflictCount).toBe(1);
    expect(() => status.setConflicts(-1)).toThrow(/\[sync\]/);
  });

  it('snapshots are frozen and rejects invalid counters', () => {
    const { status } = model();
    status.setPrompt({ kind: 'epoch-legacy', id: 'epoch-legacy' });
    const snap = status.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.prompts)).toBe(true);
    expect(() => status.update({ unsyncedOps: -1 })).toThrow(/\[sync\]/);
    expect(() => status.update({ backoffUntilMs: Number.NaN })).toThrow(/\[sync\]/);
  });

  it('a failing emitter is logged, not thrown', () => {
    const logger = new MemoryLogger();
    const events = {
      emit: () => {
        throw new Error('renderer gone');
      },
    };
    const status = new SyncStatusModel(LINEAGE, { events, clock: new FakeClock(), logger });
    status.update({ cycleRunning: true });
    expect(status.snapshot().kind).toBe('syncing');
    expect(logger.messages('error')).toEqual(['[sync] status event failed']);
    expect(logger.unprefixed()).toEqual([]);
  });
});
