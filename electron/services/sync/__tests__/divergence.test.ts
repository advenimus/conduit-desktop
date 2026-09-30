// @vitest-environment node
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyLocalWrites, presenceWrite } from '../capture-local.js';
import { DIVERGENCE_SNOOZE_MS, DIVERGENCE_UNCOVERED_MS, DivergenceTracker, detectDifferentFiles, type DivergenceInput } from '../divergence.js';
import { deriveEpochKeys, makeImplicitProvider } from '../hashing.js';
import { emptyState } from '../state-view.js';
import type { SessionRowView } from '../host.js';
import type { FileHint, SyncContext, SyncState, VersionVector } from '../types.js';
import { FakeClock } from './host-fakes.js';
import { presenceValue } from './file-binding-fixtures.js';

const LINEAGE = '6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5';
const OWN = '00000000-0000-4000-8000-000000000001';
const MAC = '00000000-0000-4000-8000-00000000000a';
const PC = '00000000-0000-4000-8000-00000000000b';
const FILE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FILE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const keys = deriveEpochKeys(crypto.randomBytes(32), LINEAGE);
const implicit = makeImplicitProvider(keys.kSync);

function ctxFor(deviceUuid: string, dev: number): SyncContext {
  return {
    deviceUuid,
    lineageId: LINEAGE,
    dev,
    incarnation: 'cd'.repeat(16),
    keys: { current: keys, byEpoch: new Map([[keys.epochId, keys]]) },
    now: () => 1_000,
    randomBytes: crypto.randomBytes,
  };
}

/** `state` plus a presence register written by `deviceUuid` (its own dev) at `ms`. */
function withPresence(state: SyncState, deviceUuid: string, dev: number, name: string, hint: FileHint | null, activeMs: number): SyncState {
  const ctx = ctxFor(deviceUuid, dev);
  const res = applyLocalWrites(
    state,
    [presenceWrite(presenceValue(name, hint, activeMs), ctx)],
    { kind: 'local', dot: { dev, ms: activeMs, c: 0 }, interactive: true },
    ctx,
    implicit,
    { ruleR: false },
  );
  return res.state;
}

function hint(fileId: string, location: string, fileName = 'Vault.conduit'): FileHint {
  return { file_id: fileId, location, file_name: fileName };
}

function row(over: Partial<SessionRowView> & Pick<SessionRowView, 'deviceId' | 'deviceName'>): SessionRowView {
  return {
    platform: 'windows',
    fileName: 'Vault.conduit',
    fileId: FILE_A,
    location: 'icloud:Vault',
    status: 'active',
    lastActiveMs: 5_000,
    busySessions: 0,
    busyJobs: 0,
    heartbeatAtMs: null,
    sideFilesFlag: false,
    marker: null,
    writtenAtMs: null,
    pendingChanges: false,
    abandoned: false,
    ...over,
  };
}

const OURS = hint(FILE_A, 'icloud:Vault');
const base = emptyState(LINEAGE, 'ee'.repeat(32), 0);

describe('detectDifferentFiles', () => {
  it('reports a device on another file_id (presence file_hint)', () => {
    const s = withPresence(base, MAC, 10, 'MacBook', hint(FILE_B, 'icloud:Vault'), 5_000);
    const found = detectDifferentFiles(s, OWN, OURS, []);
    expect(found).toEqual([{ kind: 'different-file', deviceUuid: MAC, deviceName: 'MacBook', theirs: hint(FILE_B, 'icloud:Vault'), ours: OURS }]);
  });

  it('reports the same file_id on another provider (12 row 48) and nothing for the same file', () => {
    const same = withPresence(base, MAC, 10, 'MacBook', hint(FILE_A, 'icloud:Other folder'), 5_000);
    expect(detectDifferentFiles(same, OWN, OURS, [])).toEqual([]);
    const pc = [row({ deviceId: PC, deviceName: 'Windows PC', location: 'onedrive:Documents' })];
    const found = detectDifferentFiles(same, OWN, OURS, pc);
    expect(found.map((f) => [f.deviceUuid, f.deviceName, f.theirs.location])).toEqual([[PC, 'Windows PC', 'onedrive:Documents']]);
  });

  it('keeps one finding per device: the session row wins only when newer', () => {
    const s = withPresence(base, MAC, 10, 'MacBook', hint(FILE_B, 'icloud:Vault'), 5_000);
    const older = [row({ deviceId: MAC, deviceName: 'MacBook (server)', fileId: FILE_A, lastActiveMs: 4_000 })];
    expect(detectDifferentFiles(s, OWN, OURS, older).map((f) => f.theirs.file_id)).toEqual([FILE_B]);
    const newer = [row({ deviceId: MAC, deviceName: 'MacBook (server)', fileId: FILE_A, lastActiveMs: 6_000 })];
    expect(detectDifferentFiles(s, OWN, OURS, newer)).toEqual([]);
  });

  it('ignores this device, devices without a hint and session rows without a file_id', () => {
    let s = withPresence(base, OWN, 9, 'This Mac', hint(FILE_B, 'dropbox:x'), 5_000);
    s = withPresence(s, MAC, 10, 'MacBook', null, 5_000);
    const rows = [row({ deviceId: OWN, deviceName: 'This Mac', fileId: FILE_B }), row({ deviceId: PC, deviceName: 'PC', fileId: null, location: null })];
    expect(detectDifferentFiles(s, OWN, OURS, rows)).toEqual([]);
  });

  it('does not compare providers when a location is unknown', () => {
    const rows = [row({ deviceId: PC, deviceName: 'PC', location: null })];
    expect(detectDifferentFiles(base, OWN, OURS, rows)).toEqual([]);
  });
});

describe('DivergenceTracker', () => {
  let clock: FakeClock;
  let tracker: DivergenceTracker;
  const marker = { dev: 77, ms: 10_000, c: 0 };
  const uncoveredVv: VersionVector = new Map([[5, { ms: 1, c: 0 }]]);
  const coveringVv: VersionVector = new Map([[77, { ms: 10_000, c: 3 }]]);

  function input(over: Partial<DivergenceInput> = {}): DivergenceInput {
    return {
      state: base,
      ownDeviceUuid: OWN,
      ownHint: OURS,
      sessions: [row({ deviceId: PC, deviceName: 'Windows PC', marker, writtenAtMs: 10_000 })],
      sharedVv: uncoveredVv,
      nowMs: clock.now(),
      lastOwnPublishMs: 20_000,
      ...over,
    };
  }

  beforeEach(() => {
    clock = new FakeClock(100_000);
    tracker = new DivergenceTracker();
  });

  it('reports a marker uncovered for 24 h while this device kept publishing', async () => {
    const t0 = clock.now();
    expect(tracker.observe(input())).toEqual([]);
    await clock.advance(DIVERGENCE_UNCOVERED_MS - 1);
    expect(tracker.observe(input())).toEqual([]);
    await clock.advance(1);
    const found = tracker.observe(input());
    expect(found).toEqual([
      { kind: 'marker-uncovered', deviceUuid: PC, deviceName: 'Windows PC', sinceMs: t0, theirs: hint(FILE_A, 'icloud:Vault'), ours: OURS },
    ]);
  });

  it('restarts the 24 h window when the marker is covered', async () => {
    tracker.observe(input());
    await clock.advance(DIVERGENCE_UNCOVERED_MS / 2);
    expect(tracker.observe(input({ sharedVv: coveringVv }))).toEqual([]);
    tracker.observe(input());
    await clock.advance(DIVERGENCE_UNCOVERED_MS / 2 + 1);
    expect(tracker.observe(input())).toEqual([]);
    await clock.advance(DIVERGENCE_UNCOVERED_MS / 2);
    expect(tracker.observe(input())).toHaveLength(1);
  });

  it('keeps counting across newer uncovered markers and when S was not read', async () => {
    const t0 = clock.now();
    tracker.observe(input());
    await clock.advance(DIVERGENCE_UNCOVERED_MS / 2);
    const newer = [row({ deviceId: PC, deviceName: 'Windows PC', marker: { dev: 77, ms: 50_000, c: 0 }, writtenAtMs: 15_000 })];
    expect(tracker.observe(input({ sessions: newer, sharedVv: null }))).toEqual([]);
    await clock.advance(DIVERGENCE_UNCOVERED_MS / 2);
    const found = tracker.observe(input({ sessions: newer }));
    expect(found.map((f) => (f.kind === 'marker-uncovered' ? f.sinceMs : null))).toEqual([t0]);
  });

  it('needs our own publish after their marker, a live marker and the same file', async () => {
    const cases: Partial<DivergenceInput>[] = [
      { lastOwnPublishMs: 9_000 },
      { lastOwnPublishMs: null },
      { sessions: [row({ deviceId: PC, deviceName: 'PC', marker, writtenAtMs: 10_000, abandoned: true })] },
      { sessions: [row({ deviceId: PC, deviceName: 'PC', marker: null })] },
    ];
    for (const c of cases) {
      const tr = new DivergenceTracker();
      tr.observe(input({ ...c, nowMs: 0 }));
      expect(tr.observe(input({ ...c, nowMs: DIVERGENCE_UNCOVERED_MS + 1 }))).toEqual([]);
    }
  });

  it('hides a snoozed device for 24 h', () => {
    const s = withPresence(base, MAC, 10, 'MacBook', hint(FILE_B, 'icloud:Vault'), 5_000);
    const now = clock.now();
    expect(tracker.observe(input({ state: s, sessions: [] }))).toHaveLength(1);
    tracker.snooze(MAC, now);
    expect(tracker.observe(input({ state: s, sessions: [], nowMs: now + DIVERGENCE_SNOOZE_MS - 1 }))).toEqual([]);
    expect(tracker.observe(input({ state: s, sessions: [], nowMs: now + DIVERGENCE_SNOOZE_MS }))).toHaveLength(1);
  });

  it('hides a dismissed device until its file_id changes', () => {
    const s = withPresence(base, MAC, 10, 'MacBook', hint(FILE_B, 'icloud:Vault'), 5_000);
    tracker.dismiss(MAC, FILE_B);
    expect(tracker.observe(input({ state: s, sessions: [] }))).toEqual([]);
    const moved = withPresence(s, MAC, 10, 'MacBook', hint('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'icloud:Vault'), 6_000);
    expect(tracker.observe(input({ state: moved, sessions: [] })).map((f) => f.theirs.file_id)).toEqual([
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ]);
  });
});
