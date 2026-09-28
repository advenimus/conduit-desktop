// Per-device hosts of the multi-device harness: every device shares one FakeClock (one simulated
// time line), optionally skewed (12 rows 6, 60, 70), and gets its own logger, emitter, faulty fs,
// working-copy host, device facts and session signals.
import type {
  AppFacts,
  Clock,
  DeviceInfo,
  Kdf,
  SessionRowView,
  SessionSignals,
  SyncHost,
  TimerHandle,
  Timers,
} from '../../host.js';
import type { AppDot, SyncState } from '../../types.js';
import { makeTestSyncHost, type FakeClock, type TestSyncHost } from '../host-fakes.js';

/** Wall clock of one device: the shared clock plus a settable offset; timers run on shared time. */
export class SkewedClock implements Clock, Timers {
  constructor(
    private readonly base: FakeClock,
    public offsetMs = 0,
  ) {}

  now(): number {
    return this.base.now() + this.offsetMs;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.base.setTimeout(fn, ms);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    return this.base.setInterval(fn, ms);
  }

  sleep(ms: number): Promise<void> {
    return this.base.sleep(ms);
  }
}

/** Mutable SessionSignals for scenario tests (null signals by default, with call records). */
export class FakeSession implements SessionSignals {
  softLock = false;
  sideFlagRecent = false;
  open = true;
  rows: SessionRowView[] = [];
  readonly markers: AppDot[] = [];
  readonly sharedStates: SyncState[] = [];
  merges = 0;
  readonly sideFileFlags: boolean[] = [];

  softLocked(): boolean {
    return this.softLock;
  }

  serverSideFilesFlagRecent(): boolean {
    return this.sideFlagRecent;
  }

  sessions(): readonly SessionRowView[] {
    return this.rows;
  }

  sessionOpen(): boolean {
    return this.open;
  }

  afterMerge(): void {
    this.merges += 1;
  }

  published(marker: AppDot): void {
    this.markers.push(marker);
  }

  sharedRead(state: SyncState): void {
    this.sharedStates.push(state);
  }

  sideFilesChanged(present: boolean): void {
    this.sideFileFlags.push(present);
  }
}

export interface DeviceHostSpec {
  readonly name: string;
  readonly platform?: DeviceInfo['platform'];
  readonly kdf?: Kdf;
  readonly app?: AppFacts;
}

export interface DeviceHost {
  readonly t: TestSyncHost;
  readonly clock: SkewedClock;
  readonly host: SyncHost;
}

/** A TestSyncHost whose clock and timers are this device's view of the shared FakeClock. */
export function makeDeviceHost(root: string, spec: DeviceHostSpec, shared: FakeClock): DeviceHost {
  const clock = new SkewedClock(shared);
  const device: DeviceInfo = { name: spec.name, platform: spec.platform ?? 'macos', appVersion: '0.18.0' };
  const t = makeTestSyncHost(root, {
    clock,
    timers: clock,
    device: { current: () => device },
    ...(spec.kdf ? { kdf: spec.kdf } : {}),
    ...(spec.app ? { app: spec.app } : {}),
  });
  return { t, clock, host: t.host };
}
