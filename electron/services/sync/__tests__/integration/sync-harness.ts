// SyncHarness (spec 13.2): 2 to 4 simulated new-build devices, each with its own syncRoot,
// device.json, W and SyncEngine, sharing one "cloud" folder through per-device mirrors
// (FakeCloud). One FakeClock drives every device; advance() moves time in steps and lets every
// engine settle between steps so timer-driven cycles (watcher polls, local-edit bursts, verify
// checks, retries) run deterministically.
import fs from 'node:fs';
import { classifyStaged } from '../../shared-file.js';
import { FakeClock, makeTempRoot } from '../host-fakes.js';
import { lineageIdFromSalt } from '../../hashing.js';
import type { LoadedFile } from '../../types.js';
import { FakeCloud, sha256 } from './fake-cloud.js';
import { HarnessDevice, type DeviceSpec, type NewVault } from './harness-device.js';
import { loadCopy, withCopy } from './vault-ops.js';

const DEFAULT_STEP_MS = 1_000;
const QUIET_ROUNDS = 3;
const QUIET_DELAY_MS = 2;
const IDLE_REAL_LIMIT_MS = 10_000;

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface JoinOptions {
  /** The key the unlock policy accepted (default: the harness vault key). */
  readonly key?: Buffer;
  /** Download the server's S into the mirror first (default true). */
  readonly download?: boolean;
  /** Run the unlock cycle (default true). */
  readonly unlockCycle?: boolean;
}

export class SyncHarness {
  readonly root: string;
  readonly clock = new FakeClock();
  /** Simulated time at construction (engines created without an advance start their intervals here). */
  readonly startMs = this.clock.now();
  readonly cloud: FakeCloud;
  readonly devices: HarnessDevice[] = [];
  vault: NewVault | null = null;

  constructor(label: string) {
    this.root = makeTempRoot(`int-${label}`);
    this.cloud = new FakeCloud({ root: this.root, clock: this.clock });
  }

  device(name: string): HarnessDevice {
    const d = this.devices.find((x) => x.name === name);
    if (d === undefined) throw new Error(`harness: no device ${name}`);
    return d;
  }

  add(spec: DeviceSpec): HarnessDevice {
    const d = new HarnessDevice(spec, this.root, spec.sharedPath ?? this.cloud.sharedPath(spec.mirror ?? spec.name), this.clock);
    this.devices.push(d);
    return d;
  }

  /**
   * Gossip until quiet: each open device takes the server's S into its mirror, runs one cycle
   * and uploads what it published. Returns the outcome kinds per round.
   */
  async syncAll(maxRounds = 6): Promise<string[][]> {
    const rounds: string[][] = [];
    for (let r = 0; r < maxRounds; r++) {
      const kinds: string[] = [];
      for (const d of this.devices) {
        if (d.closed) continue;
        this.cloud.download(d.mirror);
        kinds.push((await d.sync()).kind);
        this.cloud.upload(d.mirror);
      }
      rounds.push(kinds);
      if (kinds.every((k) => k === 'up-to-date')) return rounds;
    }
    return rounds;
  }

  /** First device: a brand-new vault, published to its mirror and uploaded. */
  async create(spec: DeviceSpec, password = 'pw'): Promise<HarnessDevice> {
    const d = this.add(spec);
    const nv = d.newVault(password);
    this.vault = { lineageId: nv.lineageId, key: nv.key, salt: nv.salt, password };
    await d.open(nv.lineageId, nv.key, nv.seed, await d.bindingFor(null));
    if (!(await d.engine.publishInitial())) throw new Error('harness: initial publish failed');
    await d.unlock(false);
    this.cloud.upload(d.spec.mirror ?? d.name);
    return d;
  }

  /** A device whose mirror holds a synced S: adopt seed (7.2 step 6). */
  async join(spec: DeviceSpec, o: JoinOptions = {}): Promise<HarnessDevice> {
    const d = this.add(spec);
    const mirror = spec.mirror ?? spec.name;
    if (o.download !== false) this.cloud.download(mirror);
    const bytes = fs.readFileSync(d.sharedPath);
    const file = this.peek(d.sharedPath);
    const key = o.key ?? this.requireVault().key;
    const sideFiles = fs.existsSync(`${d.sharedPath}-wal`) || fs.existsSync(`${d.sharedPath}-shm`);
    const seed = {
      kind: 'adopt',
      sharedBytes: bytes,
      sharedSha256: sha256(bytes),
      sharedMtimeMs: Math.floor(fs.statSync(d.sharedPath).mtimeMs),
      holdLegacy: sideFiles,
    } as const;
    await d.open(file.state.lineageId, key, seed, await d.bindingFor(file.fileId));
    await d.unlock(o.unlockCycle !== false);
    return d;
  }

  /** A device whose mirror holds a pre-sync (legacy) S: G1 genesis seed. */
  async genesis(spec: DeviceSpec, key: Buffer, o: { readonly download?: boolean; readonly unlockCycle?: boolean } = {}): Promise<HarnessDevice> {
    const d = this.add(spec);
    if (o.download !== false) this.cloud.download(spec.mirror ?? spec.name);
    const bytes = fs.readFileSync(d.sharedPath);
    // Never open S in place: a WAL-mode header would leave -wal/-shm next to it.
    const salt = withCopy(d.sharedPath, `${this.root}/peek`, (db) => (db.prepare("SELECT value FROM vault_meta WHERE key = 'salt'").get() as { value: string }).value);
    const lineageId = lineageIdFromSalt(salt);
    if (this.vault === null) this.vault = { lineageId, key, salt, password: '' };
    await d.open(lineageId, key, { kind: 'genesis', sharedBytes: bytes }, await d.bindingFor(null));
    await d.unlock(o.unlockCycle !== false);
    return d;
  }

  requireVault(): NewVault {
    if (this.vault === null) throw new Error('harness: no vault yet');
    return this.vault;
  }

  /** Loads a synced file through a private copy. */
  peek(file: string): LoadedFile {
    return loadCopy(file, `${this.root}/peek`);
  }

  /** Classifies a file as the engine would (private staged copy). */
  classify(file: string) {
    const bytes = fs.readFileSync(file);
    const staged = `${this.root}/peek/cls-${sha256(bytes)}.conduit`;
    fs.mkdirSync(`${this.root}/peek`, { recursive: true });
    fs.writeFileSync(staged, bytes);
    const st = fs.statSync(file);
    const snapshot = {
      path: file,
      bytes,
      sha256: sha256(bytes),
      stagedPath: staged,
      stat: { size: st.size, mtimeMs: st.mtimeMs, ino: String(st.ino), isFile: true, isDirectory: false, isSymbolicLink: false },
    };
    return classifyStaged(snapshot, { lineageId: null });
  }

  /** Waits until every engine is idle for a few quiet rounds (bounded in real time: a hang fails). */
  async idle(): Promise<void> {
    for (let round = 0; round < QUIET_ROUNDS; round++) {
      await realDelay(QUIET_DELAY_MS);
      await this.allIdle();
    }
  }

  private async allIdle(): Promise<void> {
    let done = false;
    const all = Promise.all(this.devices.map((d) => (d.engine ? d.engine.whenIdle() : Promise.resolve()))).then(() => {
      done = true;
    });
    const deadline = Date.now() + IDLE_REAL_LIMIT_MS;
    while (!done) {
      if (Date.now() > deadline) throw new Error('harness: engines did not settle (a cycle waits on simulated time?)');
      await realDelay(1);
    }
    await all;
  }

  /**
   * One jump of simulated time (due timers fire in order: verify checks, retries, polls), then
   * waits for every engine to settle. For long waits where step-by-step polling is not the point.
   */
  async jump(ms: number): Promise<void> {
    await this.clock.advance(ms);
    await this.idle();
  }

  /** Awaits `p` while simulated time moves in small steps (for work that sleeps on host timers). */
  async whileAdvancing<T>(p: Promise<T>, stepMs = 100, maxMs = 60_000): Promise<T> {
    let settled = false;
    const done = p.finally(() => {
      settled = true;
    });
    for (let spent = 0; !settled && spent < maxMs; spent += stepMs) {
      await this.clock.advance(stepMs);
      await realDelay(1);
    }
    return done;
  }

  /** Moves simulated time forward in steps, letting every engine settle after each step. */
  async advance(ms: number, stepMs = DEFAULT_STEP_MS): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      await this.clock.advance(step);
      await this.idle();
      left -= step;
    }
  }

  /** Stops every engine, closes every W and removes the temp root; returns disposal errors. */
  async dispose(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const d of this.devices) {
      try {
        if (d.engine) await d.engine.stop();
        if (d.replica) d.replica.close();
      } catch (err) {
        errors.push(err);
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true });
    return errors;
  }
}
