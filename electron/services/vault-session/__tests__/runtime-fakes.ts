// Doubles for the PersonalVaultRuntime tests: an engine that records the calls the runtime makes
// (final cycle, stop, triggers, status badge and waiting state) and an in-memory replica with a
// real LocalJson, plus states carrying presence and owner-claim registers.
import { deviceRegKey, ownerRegKey } from '../../sync/catalog.js';
import { vhashOfValue } from '../../sync/hashing.js';
import { jcs } from '../../sync/jcs.js';
import { defaultLocalJson } from '../../sync/local-state.js';
import type { ReplicaPort } from '../../sync/replica.js';
import type { FinalKind, FinalOutcome, SyncEngine } from '../../sync/sync-engine.js';
import type { WaitingState } from '../../sync/host.js';
import type { FileHint, LocalJson, LocalWrite, PresenceValue, SyncState } from '../../sync/types.js';
import { appSib, epochKeysFor, makeState, recordFor, seqRandom, withRegister } from '../../sync/__tests__/key-epoch-fixtures.js';

export const USER = '11111111-1111-4111-8111-111111111111';
export const LINEAGE = '6f1c1d3e-8b1e-4f7a-9d55-0c2f6a1b2c3d';
export const OWN = '22222222-2222-4222-8222-222222222222';
export const OTHER = '33333333-3333-4333-8333-333333333333';
export const NONCE = '66666666-6666-4666-8666-666666666666';
export const FILE_ID = '77777777-7777-4777-8777-777777777777';
export const HINT: FileHint = { file_id: FILE_ID, location: 'icloud:Vaults', file_name: 'Vault.conduit' };

const E1 = epochKeysFor('pw', 'salt1');
export const BASE_STATE: SyncState = makeState({ current: E1, records: [recordFor(E1, null, 'salt1', seqRandom(4))] });

export class RuntimeEngine {
  readonly calls: string[] = [];
  readonly badges: (string | null)[] = [];
  readonly waits: (WaitingState | null)[] = [];
  final: FinalOutcome = { published: true, timedOut: false, pendingPublish: false, marker: null };
  /** When set, finalCycle waits for it (a hung final cycle). */
  finalGate: Promise<void> | null = null;
  shared: SyncState | null = null;

  async finalCycle(kind: FinalKind): Promise<FinalOutcome> {
    this.calls.push(`final:${kind}`);
    if (this.finalGate !== null) await this.finalGate;
    return this.final;
  }

  async stop(): Promise<void> {
    this.calls.push('stop');
  }

  trigger(t: string): void {
    this.calls.push(`trigger:${t}`);
  }

  async exclusive<T>(fn: () => T): Promise<T> {
    this.calls.push('exclusive');
    return fn();
  }

  lastSharedState(): SyncState | null {
    return this.shared;
  }

  parts(): unknown {
    return {
      status: {
        setSessionBadge: (b: string | null) => this.badges.push(b),
        setWaiting: (w: WaitingState | null) => this.waits.push(w),
      },
      binding: { fileHint: () => HINT },
    };
  }

  asEngine(): SyncEngine {
    return this as unknown as SyncEngine;
  }
}

export class RuntimeReplica {
  readonly lineageId = LINEAGE;
  readonly deviceUuid = OWN;
  readonly writes: (readonly LocalWrite[])[] = [];
  closed = 0;
  current: SyncState = BASE_STATE;
  localJson: LocalJson;

  constructor(private readonly log: string[] | null = null) {
    this.localJson = { ...defaultLocalJson(LINEAGE, 3, 'cd'.repeat(16)), binding: { sharedPath: '/cloud/Vault.conduit', realpath: '/cloud/Vault.conduit', fileId: FILE_ID } };
  }

  state(): SyncState {
    return this.current;
  }

  local(): LocalJson {
    return this.localJson;
  }

  updateLocal(fn: (l: LocalJson) => LocalJson): LocalJson {
    this.localJson = fn(this.localJson);
    return this.localJson;
  }

  applyWrites(writes: readonly LocalWrite[]): void {
    this.writes.push(writes);
  }

  context(): unknown {
    return { deviceUuid: OWN, lineageId: LINEAGE, dev: 3, incarnation: 'cd'.repeat(16), keys: null, now: () => 0, randomBytes: seqRandom(8) };
  }

  close(): void {
    this.closed += 1;
    this.log?.push('close');
  }

  asReplica(): ReplicaPort {
    return this as unknown as ReplicaPort;
  }
}

export function presence(name: string, lastActiveMs: number, sessionOpen: 0 | 1 = 1): PresenceValue {
  return {
    platform: 'macos',
    name,
    app_version: '0.18.0',
    first_seen_ms: 0,
    last_active_ms: lastActiveMs,
    session_open: sessionOpen,
    session_since_ms: sessionOpen === 1 ? 0 : null,
    account_hint: null,
    file_hint: HINT,
    side_files_seen_ms: null,
  };
}

/** BASE_STATE plus another device's presence and, optionally, its owner claim. */
export function stateWithClaim(p: PresenceValue, claim: boolean): SyncState {
  const pKey = deviceRegKey(OTHER);
  const pText = jcs(p);
  let s = withRegister(BASE_STATE, pKey, [appSib(21, 5_000, pText, vhashOfValue(pKey, pText))]);
  if (!claim) return s;
  const cKey = ownerRegKey();
  const cText = jcs({ a: null, d: OTHER });
  s = withRegister(s, cKey, [appSib(21, 5_000, cText, vhashOfValue(cKey, cText))]);
  return s;
}

/** `state` whose provisional owner claim is this device's (written after the other device's). */
export function withOwnClaim(state: SyncState): SyncState {
  const cKey = ownerRegKey();
  const cText = jcs({ a: null, d: OWN });
  return withRegister(state, cKey, [appSib(3, 9_000, cText, vhashOfValue(cKey, cText))]);
}
