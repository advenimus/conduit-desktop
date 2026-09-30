/**
 * What a runtime starts (spec 6.2, 6.8, 6.11): the heartbeat loop and the
 * Realtime subscription of a signed-in device, and the stale-file wait of a shared vault
 * (markers of the acquire answer not covered by the first read; Free a dialog, Pro a banner;
 * signed out, the presence hint). Part of session-runtime.ts.
 */

import { listPresence } from '../sync/presence.js';
import type { ReplicaPort } from '../sync/replica.js';
import type { SyncEngine } from '../sync/sync-engine.js';
import { HeartbeatLoop, type HeartbeatEvents } from './heartbeat.js';
import type { LeaseTracker } from './lease.js';
import { SessionRealtime } from './realtime.js';
import type { AcquireResult, SessionClientPort, SessionIds } from './session-client.js';
import { StaleWait, signedOutHint } from './stale-wait.js';
import type { DisplacementReason, SessionConfig, SessionHost } from './host.js';
import { acquireArgsFor, guarded, heartbeatContextFor, startingMarkers, type FileFacts } from './session-runtime-parts.js';

/** The displaced modal waits this long at most for the name of the device that took over. */
export const NAME_LOOKUP_TIMEOUT_MS = 2_000;

export interface LinkInputs {
  readonly host: SessionHost;
  readonly config: SessionConfig;
  readonly ids: SessionIds;
  readonly client: SessionClientPort;
  readonly lease: LeaseTracker;
  readonly facts: () => FileFacts;
  readonly sideFilesPresent: () => boolean;
  readonly pendingPublish: () => boolean;
  readonly events: HeartbeatEvents;
  readonly onDisplaced: (reason: DisplacementReason, byDeviceName: string | null) => void;
}

export interface ServerLinks {
  readonly heartbeat: HeartbeatLoop;
  readonly realtime: SessionRealtime;
}

/** Heartbeat (30 s, or acquire every 60 s while unconfirmed) and Realtime, both started. */
export function startServerLinks(input: LinkInputs): ServerLinks {
  const { host, client, lease, config, ids } = input;
  const heartbeat = new HeartbeatLoop({
    ids,
    client,
    lease,
    host,
    acquireArgs: () => acquireArgsFor(host, { ...ids, sessionNonce: config.sessionNonce, facts: input.facts(), takeover: false, claim: false }),
    context: () => heartbeatContextFor(input.facts(), input.sideFilesPresent(), input.pendingPublish()),
    events: input.events,
  });
  const realtime = new SessionRealtime({
    realtime: host.realtime,
    vaultKey: ids.vaultKey,
    deviceId: ids.deviceId,
    lease,
    host,
    deviceName: (id, sessions) => sessions.find((s) => s.deviceId.toLowerCase() === id.toLowerCase())?.deviceName ?? null,
    lookupName: async (id) => {
      const res = await client.peek(ids, NAME_LOOKUP_TIMEOUT_MS);
      return res.kind === 'ok' ? (res.holders.find((h) => h.deviceId.toLowerCase() === id.toLowerCase())?.deviceName ?? null) : null;
    },
    onDisplaced: input.onDisplaced,
    beatNow: () => void heartbeat.beatNow(),
    sessionNonce: config.sessionNonce,
  });
  heartbeat.start();
  realtime.start();
  return { heartbeat, realtime };
}

export interface StaleInputs {
  readonly host: SessionHost;
  readonly ids: SessionIds;
  readonly client: SessionClientPort;
  readonly engine: SyncEngine;
  readonly replica: ReplicaPort;
  readonly acquire: AcquireResult | null;
  readonly signedIn: boolean;
  /** Effective limit 1: a blocking dialog; otherwise a banner (6.11). */
  readonly limit: () => number;
}

/** The stale-file wait of 6.11 (or the signed-out hint), begun when something is uncovered. */
export function startStaleWait(input: StaleInputs): StaleWait {
  const { host, ids, client, engine, replica, acquire } = input;
  const wait = new StaleWait({ ids, client, replica, status: engine.parts().status, host, requestRead: () => engine.trigger('session-hint') });
  guarded(host.logger, 'stale wait start', () => {
    const lastShared = engine.lastSharedState();
    if (!input.signedIn) {
      // The hint only matters when this device may not run alongside the other one.
      if (input.limit() !== 1) return;
      const hint = signedOutHint(listPresence(lastShared ?? replica.state()), ids.deviceId, host.clock.now());
      if (hint !== null) wait.beginSignedOut(hint);
      return;
    }
    if (acquire?.kind !== 'granted') return;
    const local = replica.local();
    const markers = startingMarkers(acquire.sessions, local.binding?.fileId ?? null, local.abandonedWaits, lastShared);
    wait.begin(markers, input.limit() === 1 ? 'dialog' : 'banner');
  });
  return wait;
}
