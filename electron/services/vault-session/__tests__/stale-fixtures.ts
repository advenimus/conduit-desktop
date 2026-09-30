// Shared seams for the stale-wait tests: session rows, a replica stand-in whose local.json is a
// real file in a temp lineage folder, a recording status sink and a scripted abandon client.
import { defaultLocalJson, readLocalJson, writeLocalJson } from '../../sync/local-state.js';
import type { ReplicaPort } from '../../sync/replica.js';
import type { SessionRowView, WaitingState } from '../../sync/host.js';
import type { AppDot, LocalJson } from '../../sync/types.js';
import type { AbandonArgs, SimpleResult } from '../session-client.js';

export const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
export const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
export const OWN_DEVICE = '11111111-1111-4111-8111-111111111111';
export const MAC = '22222222-2222-4222-8222-222222222222';
export const PHONE = '33333333-3333-4333-8333-333333333333';
export const FILE_ID = '44444444-4444-4444-8444-444444444444';
export const OTHER_FILE_ID = '55555555-5555-4555-8555-555555555555';

export function marker(dev: number, ms: number, c = 0): AppDot {
  return { dev, ms, c };
}

export function row(patch: Partial<SessionRowView> & Pick<SessionRowView, 'deviceId'>): SessionRowView {
  return {
    deviceName: 'MacBook',
    platform: 'macos',
    fileName: 'Vault.conduit',
    fileId: FILE_ID,
    location: 'icloud:Vaults',
    status: 'released',
    lastActiveMs: NOW - 60_000,
    busySessions: 0,
    busyJobs: 0,
    heartbeatAtMs: null,
    sideFilesFlag: false,
    marker: null,
    writtenAtMs: null,
    pendingChanges: false,
    abandoned: false,
    ...patch,
  };
}

/** local() / updateLocal() over a real local.json in `dir`. */
export class FileLocalReplica implements Pick<ReplicaPort, 'local' | 'updateLocal'> {
  private current: LocalJson;

  constructor(private readonly dir: string, seed: Partial<LocalJson> = {}) {
    this.current = { ...defaultLocalJson(LINEAGE, 101, 'cd'.repeat(16)), ...seed };
    writeLocalJson(dir, this.current);
  }

  local(): LocalJson {
    return this.current;
  }

  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson {
    const next = fn(this.current);
    writeLocalJson(this.dir, next);
    this.current = next;
    return next;
  }

  onDisk(): LocalJson {
    const read = readLocalJson(this.dir, NOW);
    if (read.value === null) throw new Error('local.json missing or corrupt');
    return read.value;
  }
}

export class RecordingStatus {
  readonly calls: (WaitingState | null)[] = [];

  setWaiting(w: WaitingState | null): void {
    this.calls.push(w);
  }

  last(): WaitingState | null | undefined {
    return this.calls[this.calls.length - 1];
  }
}

export class AbandonClient {
  readonly calls: AbandonArgs[] = [];
  answer: SimpleResult = { kind: 'ok' };

  async abandon(args: AbandonArgs): Promise<SimpleResult> {
    this.calls.push(args);
    return this.answer;
  }
}
