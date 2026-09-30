// @vitest-environment node
// Copy scanner and file binding over the real siblings: openReplica (G1 genesis W through the
// TestWorkingCopyHost), FileBindingTracker, shared-file and notices. Only the candidate queue
// is a recorder.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddFileInput, PendingCandidate } from '../candidate-queue.js';
import { CopyScanner } from '../copy-scanner.js';
import { FileBindingTracker, newBinding } from '../file-binding.js';
import { Notices } from '../notices.js';
import type { ReplicaPort } from '../replica.js';
import { createSharedFile } from '../shared-file.js';
import { SnapshotStore } from '../snapshots.js';
import type { SyncNoticeEvent } from '../host.js';
import { SimDevice } from './core-e2e-harness.js';
import { createLegacyVault, entryRow, type LegacyFixture } from './core-e2e-fixtures.js';
import { makeTempRoot } from './host-fakes.js';
import { makeDevice, open, type TestDevice } from './replica-fixtures.js';
import { presenceValue, writePresence } from './file-binding-fixtures.js';

const ONEDRIVE = 'Vault-DESKTOP-ABC.conduit';

let worldRoot: string;
let legacy: LegacyFixture;

beforeAll(() => {
  worldRoot = makeTempRoot('copy-scanner-int-world');
  fs.mkdirSync(path.join(worldRoot, 'legacy'));
  legacy = createLegacyVault(path.join(worldRoot, 'legacy'));
}, 30_000);

afterAll(() => {
  fs.rmSync(worldRoot, { recursive: true, force: true });
});

describe('CopyScanner with the real replica', () => {
  let root: string;
  let d: TestDevice;
  let replica: ReplicaPort;
  let B: SimDevice;
  let share: string;
  let S: string;
  let added: AddFileInput[];

  beforeEach(async () => {
    root = makeTempRoot('copy-scanner-int');
    d = makeDevice(root);
    share = path.join(root, 'share');
    fs.mkdirSync(share);
    S = path.join(share, 'Vault.conduit');
    fs.writeFileSync(S, legacy.source.bytes);
    const binding = await newBinding(S, d.t.host);
    const opened = await open(d, legacy.source.lineageId, legacy.source.key, { kind: 'genesis', sharedBytes: legacy.source.bytes }, binding);
    replica = opened.replica;
    fs.rmSync(S);
    createSharedFile(d.t.host).vacuumInto(replica.database(), S);
    B = new SimDevice({ name: 'B', root, source: legacy.source, now: () => d.t.clock.now() + 60_000 });
    added = [];
  });

  afterEach(() => {
    B.close();
    replica.close();
    expect(d.t.logger.unprefixed()).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function scannerWith(tracker: FileBindingTracker): CopyScanner {
    return new CopyScanner({
      replica,
      binding: tracker,
      shared: createSharedFile(d.t.host),
      candidates: {
        addFile: async (input: AddFileInput): Promise<PendingCandidate> => {
          added.push(input);
          return {
            id: 'cand',
            source: input.source,
            label: input.label,
            kind: 'synthetic',
            staleByNature: input.staleByNature,
            payload: { kind: 'file', path: input.path, sha256: '' },
            createdMs: 0,
          };
        },
      },
      notices: new Notices({ replica, host: d.t.host }),
      session: { sessions: () => [] },
      host: d.t.host,
      snapshots: new SnapshotStore(replica.paths.snapshots, d.t.host),
    });
  }

  it('merges a OneDrive conflict copy into W, keeps the copy and persists the ignored SHA', async () => {
    const tracker = new FileBindingTracker({ replica, shared: createSharedFile(d.t.host), host: d.t.host });
    expect(tracker.ensureFileId(null, false).fileId).toBe(replica.local().binding?.fileId);

    B.edit((v) => v.updateEntry(legacy.ids.db, { notes: 'edited on DESKTOP-ABC' }));
    writePresence(B, presenceValue('DESKTOP-ABC', null, d.t.clock.now()));
    const copyPath = path.join(share, ONEDRIVE);
    B.publish(copyPath);
    fs.copyFileSync(S, path.join(share, 'Vault 2.conduit'));

    const scanner = scannerWith(tracker);
    const res = await scanner.scan();
    expect(res.copies.map((c) => [c.name, c.cls])).toEqual([
      ['Vault 2.conduit', 'nothing-new'],
      [ONEDRIVE, 'safe-provider-copy'],
    ]);
    const generation = replica.generation();
    const copy = res.copies.find((c) => c.name === ONEDRIVE);
    const outcome = await scanner.mergeSafe(copy!);
    expect(outcome?.generation).toBe(generation + 1);
    expect(replica.generation()).toBe(generation + 1);
    expect(entryRow(replica.database(), legacy.ids.db)?.notes).toBe('edited on DESKTOP-ABC');
    expect(fs.existsSync(copyPath)).toBe(true);
    expect(replica.local().ignoredCopies).toEqual([copy!.sha256]);
    const onDisk = JSON.parse(fs.readFileSync(replica.paths.local, 'utf8')) as { ignoredCopies: string[] };
    expect(onDisk.ignoredCopies).toEqual([copy!.sha256]);
    const toast = d.t.events.of('sync:notice').find((e: SyncNoticeEvent) => !e.persisted);
    expect(toast?.notice).toMatchObject({ kind: 'copy-merged', params: { name: ONEDRIVE, provider: 'onedrive' } });

    const again = await scanner.scan();
    expect(again.copies.map((c) => [c.name, c.cls])).toEqual([['Vault 2.conduit', 'nothing-new']]);
  });

  it('rebinds through the real replica when S is renamed on another device (12 row 19)', async () => {
    const tracker = new FileBindingTracker({ replica, shared: createSharedFile(d.t.host), host: d.t.host });
    const before = tracker.binding();
    fs.renameSync(S, path.join(share, 'Renamed.conduit'));
    const res = await tracker.resolveMissing();
    expect(res.kind).toBe('rebound');
    const stored = JSON.parse(fs.readFileSync(replica.paths.local, 'utf8')) as { binding: { realpath: string; fileId: string } };
    expect(stored.binding).toMatchObject({ realpath: fs.realpathSync(path.join(share, 'Renamed.conduit')), fileId: before.fileId });
    expect(await tracker.undoRebind()).toBe(true);
    expect(replica.local().binding).toEqual(before);
  });
});
