// Test seams for file-binding, side-files, copy-scanner and divergence: a local.json-only
// replica stand-in (writes go through the real validating writer), a replica over a core
// SimDevice (state, ring, commits), presence values and small file helpers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { presenceWrite } from '../capture-local.js';
import { defaultLocalJson, writeLocalJson } from '../local-state.js';
import { ensureLineageDirs, lineagePaths, type LineagePaths } from '../paths.js';
import type { CommitOutcome, ReplicaPort } from '../replica.js';
import type { FileBinding, FileHint, LocalJson, PresenceValue, SyncState } from '../types.js';
import type { SimDevice } from './core-e2e-harness.js';

export const LINEAGE = '0b5e3c1a-7a55-4c2e-9e4b-1d2f3a4b5c6d';
export const DEVICE_UUID = '11111111-2222-4333-8444-555555555555';
const INCARNATION = 'ab'.repeat(16);

/** local.json owner stand-in: the parts of ReplicaPort that side-files and file-binding use. */
export class LocalReplica {
  readonly paths: LineagePaths;
  writes = 0;
  failNextWrite = false;
  private value: LocalJson;

  constructor(
    root: string,
    readonly lineageId: string = LINEAGE,
    readonly deviceUuid: string = DEVICE_UUID,
    binding: FileBinding | null = null,
  ) {
    this.paths = lineagePaths(path.join(root, 'm-test'), lineageId);
    ensureLineageDirs(this.paths);
    this.value = { ...defaultLocalJson(lineageId, 1, INCARNATION), binding };
    writeLocalJson(this.paths.dir, this.value);
  }

  local(): LocalJson {
    return this.value;
  }

  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson {
    const next = fn(this.value);
    if (next === this.value) return next;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('[sync] test: local.json write failed');
    }
    writeLocalJson(this.paths.dir, next);
    this.writes++;
    this.value = next;
    return next;
  }

  /** What is on disk (proves the written value validates and round-trips). */
  onDisk(): unknown {
    return JSON.parse(fs.readFileSync(this.paths.local, 'utf8'));
  }
}

/**
 * A ReplicaPort over a core SimDevice (W = the device's working copy). Only what the copy
 * scanner and divergence use is real; everything else throws.
 */
export function simReplica(device: SimDevice, local: LocalReplica): ReplicaPort {
  let generation = 0;
  const commitWith = (fn: (w: SyncState) => SyncState): CommitOutcome => {
    const m = device.commit(fn(device.state));
    generation++;
    return { state: device.state, changedRows: m.changedRows, structural: m.structural, generation };
  };
  const unsupported = (name: string) => (): never => {
    throw new Error(`simReplica: ${name} is not supported in this test`);
  };
  const port = {
    lineageId: device.ctx.lineageId,
    deviceUuid: device.deviceUuid,
    paths: local.paths,
    journalMode: 'wal' as const,
    database: () => device.db,
    dev: () => device.dev,
    context: () => device.ctx,
    ring: () => device.keys,
    implicit: () => device.implicit,
    state: () => device.state,
    generation: () => generation,
    structural: () => device.structural,
    epochAligned: () => true,
    receive: () => undefined,
    commitWith,
    local: () => local.local(),
    updateLocal: (fn: (l: LocalJson) => LocalJson) => local.updateLocal(fn),
    bump: () => {
      generation++;
    },
    handle: undefined,
    incarnation: unsupported('incarnation'),
    current: unsupported('current'),
    tick: () => device.tick(),
    highWaterCheck: unsupported('highWaterCheck'),
    startNewIncarnation: unsupported('startNewIncarnation'),
    fullPass: unsupported('fullPass'),
    applyWrites: unsupported('applyWrites'),
    commit: unsupported('commit'),
    commitIfGeneration: unsupported('commitIfGeneration'),
    setRing: unsupported('setRing'),
    hooks: unsupported('hooks'),
    onLocalCommit: unsupported('onLocalCommit'),
    onFullPassRequest: unsupported('onFullPassRequest'),
    changePassword: unsupported('changePassword'),
    close: () => undefined,
  };
  return port as unknown as ReplicaPort;
}

export function presenceValue(name: string, fileHint: FileHint | null, lastActiveMs: number, platform = 'windows'): PresenceValue {
  return {
    platform,
    name,
    app_version: '0.18.0',
    first_seen_ms: lastActiveMs - 1000,
    last_active_ms: lastActiveMs,
    session_open: 1,
    session_since_ms: lastActiveMs - 1000,
    account_hint: null,
    file_hint: fileHint,
    side_files_seen_ms: null,
  };
}

/** Writes this device's presence register into its W as one interactive operation. */
export function writePresence(device: SimDevice, value: PresenceValue): void {
  device.write([presenceWrite(value, device.ctx)]);
}

export function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Names and SHA-256 of every file in `dir` (proves a scan moved and changed nothing). */
export function dirFingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) out[name] = sha256File(p);
  }
  return out;
}

export function uuid(): string {
  return crypto.randomUUID();
}

