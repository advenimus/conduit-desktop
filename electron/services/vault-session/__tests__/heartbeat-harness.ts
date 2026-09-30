// Shared setup of the HeartbeatLoop tests: a session host on a FakeClock with ScriptedRpc, the
// real SessionClient, a lease tracker, a mutable heartbeat context and recorded events.
import * as fs from 'node:fs';
import { expect } from 'vitest';
import { makeTempRoot } from '../../sync/__tests__/host-fakes.js';
import { makeTestSessionHost, rpcFail, rpcOk, type RpcCall, type TestSessionHost } from './session-fakes.js';
import { FILE_ID, LEASE, NONCE, TS, USER, VAULT, DEVICE, holderRow } from './session-client-fixtures.js';
import { HeartbeatLoop, type HeartbeatContext, type HeartbeatDeps } from '../heartbeat.js';
import { SessionClient, type AcquireArgs } from '../session-client.js';
import { LeaseTracker } from '../lease.js';
import type { DisplacementReason, Holder, RpcResult } from '../host.js';

export const ACQUIRE: AcquireArgs = {
  vaultKey: VAULT,
  deviceId: DEVICE,
  sessionNonce: NONCE,
  deviceName: 'Test Mac',
  platform: 'macos',
  appVersion: '0.18.0',
  fileName: 'Vault.conduit',
  fileId: FILE_ID,
  location: 'Dropbox',
  // The loop must force takeover and claim false on re-acquire whatever the runtime passes.
  takeover: true,
  claim: true,
};

export const okBeat = (limit = 1): RpcResult => rpcOk({ status: 'ok', limit, sessions: [], server_now: TS });
export const granted = (leaseId: string, limit = 1): RpcResult => rpcOk({ granted: true, lease_id: leaseId, limit, sessions: [], server_now: TS });
export const denied = (): RpcResult => rpcOk({ granted: false, limit: 1, holders: [holderRow()], sessions: [], server_now: TS });
export const lost = (reason: string): RpcResult => rpcOk({ status: 'lost', reason });
export const displacedAnswer = (reason: string, by: string | null): RpcResult => rpcOk({ status: 'displaced', reason, by });
export const offline = (): RpcResult => rpcFail({ kind: 'network' });

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface Recorded {
  readonly displaced: [DisplacementReason, string | null][];
  readonly conflicts: (readonly Holder[])[];
  /** isConfirmed at each leaseChanged event. */
  readonly leaseChanged: boolean[];
  readonly limits: number[];
  /** Every good answer's limit (limitConfirmed). */
  readonly confirmedLimits: number[];
}

export class HeartbeatHarness {
  readonly root = makeTempRoot('heartbeat');
  readonly t: TestSessionHost = makeTestSessionHost(this.root);
  readonly lease: LeaseTracker = new LeaseTracker();
  readonly rec: Recorded = { displaced: [], conflicts: [], leaseChanged: [], limits: [], confirmedLimits: [] };
  ctx: HeartbeatContext = { fileName: 'Vault.conduit', fileId: FILE_ID, location: 'Dropbox', sideFilesPresent: false, pendingChanges: false };
  loop: HeartbeatLoop;

  constructor() {
    this.t.knobs.userId = USER;
    this.loop = this.makeLoop();
  }

  makeLoop(overrides: Partial<HeartbeatDeps> = {}): HeartbeatLoop {
    const { rec } = this;
    return new HeartbeatLoop({
      ids: { vaultKey: VAULT, deviceId: DEVICE },
      client: new SessionClient(this.t.rpc, this.t.host),
      lease: this.lease,
      host: this.t.host,
      acquireArgs: () => ACQUIRE,
      context: () => this.ctx,
      events: {
        displaced: (reason, by) => rec.displaced.push([reason, by]),
        reconnectConflict: (holders) => rec.conflicts.push(holders),
        leaseChanged: () => rec.leaseChanged.push(this.lease.isConfirmed(this.t.clock.now())),
        limitChanged: (limit) => rec.limits.push(limit),
        limitConfirmed: (limit) => rec.confirmedLimits.push(limit),
      },
      ...overrides,
    });
  }

  beats(): RpcCall[] {
    return this.t.rpc.callsOf('vault_session_heartbeat');
  }

  acquires(): RpcCall[] {
    return this.t.rpc.callsOf('vault_session_acquire');
  }

  /** Lease granted now (LEASE, limit 1), then start(). */
  startConfirmed(limit = 1): void {
    this.lease.onAcquire({ kind: 'granted', leaseId: LEASE, limit, sessions: [], serverNowMs: null, deviceCap: null, ownership: null }, this.t.clock.now());
    this.loop.start();
  }

  /** Stops the loop, asserts no timers leaked and every log line is prefixed, removes the temp root. */
  dispose(): void {
    this.loop.stop();
    expect(this.t.clock.pending()).toBe(0);
    expect(this.t.logger.unprefixed()).toEqual([]);
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}
