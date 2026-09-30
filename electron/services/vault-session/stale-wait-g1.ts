/**
 * The 4.4 G1 wait ("Getting the synced vault from MacBook...") and the 6.11 signed-out hint
 * (part of stale-wait.ts).
 */

import { isRecentlyActive, type PresenceEntry } from '../sync/presence.js';
import type { SessionRowView, SyncLogger, WaitingState } from '../sync/host.js';
import type { SessionHost } from './host.js';
import { G1_WAIT_MS, STALE_POLL_MS, errorMeta, sameId, setWaitingSafely, waitingDevices, type ExpectedMarker } from './stale-wait-markers.js';

export type SharedProbe = 'synced' | 'presync' | 'missing' | 'unreadable' | 'foreign';

export interface G1WaitInput {
  /** Sessions from acquire; the wait happens only when some row carries a marker. */
  readonly sessions: readonly SessionRowView[];
  /** Re-reads and classifies S. */
  readonly probe: () => Promise<SharedProbe>;
  readonly host: Pick<SessionHost, 'clock' | 'timers' | 'logger'>;
  /** Shows or hides the waiting state (purpose 'first-genesis'). */
  readonly waiting: (state: WaitingState | null) => void;
  /** Resolves when the user clicks [Continue anyway]. */
  readonly continueRequested: Promise<void>;
  /** Resolves when the vault is locked or the app quits mid-open: the wait ends at once. */
  readonly cancelRequested?: Promise<void>;
}

type G1Outcome = 'synced' | 'timeout' | 'continued' | 'cancelled' | 'not-needed';

type SignalKind = 'continue' | 'cancel';

const NEVER = new Promise<never>(() => undefined);

/** The first of [Continue anyway] and a cancel; a rejected request never fires. */
class WaitSignal {
  fired: SignalKind | null = null;
  readonly promise: Promise<void>;

  constructor(continueRequested: Promise<void>, cancelRequested: Promise<void> | undefined, logger: SyncLogger) {
    const settle = (kind: SignalKind) => (request: Promise<void>) =>
      request.then(
        () => kind,
        (err: unknown) => {
          logger.warn(`[vault-session] ${kind} request failed`, errorMeta(err));
          return NEVER;
        },
      );
    const kinds = [settle('continue')(continueRequested), cancelRequested === undefined ? NEVER : settle('cancel')(cancelRequested)];
    this.promise = Promise.race(kinds).then((kind) => {
      this.fired ??= kind;
    });
  }

  outcome(): 'continued' | 'cancelled' | null {
    if (this.fired === null) return null;
    return this.fired === 'cancel' ? 'cancelled' : 'continued';
  }
}

function delayOrSignal(timers: G1WaitInput['host']['timers'], ms: number, signal: WaitSignal): Promise<'elapsed' | 'signal'> {
  return new Promise((resolve) => {
    const handle = timers.setTimeout(() => resolve('elapsed'), ms);
    void signal.promise.then(() => {
      handle.cancel();
      resolve('signal');
    });
  });
}

async function probeSafely(input: G1WaitInput): Promise<SharedProbe> {
  try {
    return await input.probe();
  } catch (err) {
    input.host.logger.warn('[vault-session] synced-file probe failed', errorMeta(err));
    return 'unreadable';
  }
}

async function pollUntilSynced(input: G1WaitInput, sinceMs: number, signal: WaitSignal): Promise<G1Outcome> {
  const { clock, timers } = input.host;
  for (;;) {
    const probed = await probeSafely(input);
    if (signal.fired === 'cancel') return 'cancelled';
    if (probed === 'synced') return 'synced';
    const early = signal.outcome();
    if (early !== null) return early;
    const remaining = sinceMs + G1_WAIT_MS - clock.now();
    if (remaining <= 0) return 'timeout';
    if ((await delayOrSignal(timers, Math.min(STALE_POLL_MS, remaining), signal)) === 'signal') return signal.outcome() ?? 'continued';
  }
}

/** 4.4 G1: polls every STALE_POLL_MS up to G1_WAIT_MS until S has sync tables. */
export async function waitForSyncedFile(input: G1WaitInput): Promise<G1Outcome> {
  const markers: readonly ExpectedMarker[] = input.sessions.flatMap((row) =>
    row.marker === null ? [] : [{ deviceId: row.deviceId, deviceName: row.deviceName, marker: row.marker, writtenAtMs: row.writtenAtMs }],
  );
  if (markers.length === 0) return 'not-needed';
  const { clock, logger } = input.host;
  const sinceMs = clock.now();
  const devices = waitingDevices(markers);
  const signal = new WaitSignal(input.continueRequested, input.cancelRequested, logger);
  setWaitingSafely(input.waiting, { purpose: 'first-genesis', devices, blocking: true, stopOffered: false, sinceMs }, logger);
  try {
    const outcome = await pollUntilSynced(input, sinceMs, signal);
    logger.info('[vault-session] synced-file wait ended', { outcome, waitedMs: clock.now() - sinceMs });
    return outcome;
  } finally {
    setWaitingSafely(input.waiting, null, logger);
  }
}

// ---------- 6.11 signed out ----------

/**
 * 6.11 signed out: the most recently active other device whose presence shows session_open = 1
 * and activity within 15 minutes ("MacBook may still have this vault open, or its last changes
 * haven't arrived yet." [Wait] [Use here]). 6.10: a stale session_open = 1 (a backgrounded
 * iPhone, a crashed or retired device) never prompts anyone; future activity times are ignored.
 */
export function signedOutHint(presence: readonly PresenceEntry[], ownDeviceUuid: string, nowMs: number): PresenceEntry | null {
  let best: PresenceEntry | null = null;
  for (const p of presence) {
    if (sameId(p.deviceUuid, ownDeviceUuid) || !isRecentlyActive(p.value, nowMs)) continue;
    if (best === null || p.value.last_active_ms > best.value.last_active_ms) best = p;
  }
  return best;
}
