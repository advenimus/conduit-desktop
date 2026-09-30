// Shared test seams for the sync engine, file IO and replica layers:
// FakeClock (clock + timers + sleep driven by advance()), MemoryLogger, RecordingEmitter,
// FaultyFs (fault injection over the real Node fs), FakeShell, a fast Kdf, a TestWorkingCopyHost
// that stands in for ConduitVault's connection, and makeTestSyncHost() bundling them.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREATE_SCHEMA, SCHEMA_VERSION } from '../../vault/schema.js';
import { createNodeSyncFs, nodeRandom } from '../host-node.js';
import type {
  AppFacts,
  Clock,
  DeviceInfo,
  Kdf,
  LogMeta,
  RendererEmitter,
  ShellHost,
  SyncEventMap,
  SyncFs,
  SyncHost,
  SyncLogger,
  TimerHandle,
  Timers,
  VaultMutationInfo,
  VaultSyncHooks,
  WorkingCopyHandle,
  WorkingCopyHost,
  WorkingCopyOpenInput,
} from '../host.js';
import type { RowKey } from '../types.js';

// ---------- Clock and timers ----------

interface FakeTimer {
  readonly id: number;
  at: number;
  readonly fn: () => void;
  readonly every: number | null;
}

const FLUSH_ROUNDS = 5;

/** Resolves after pending microtasks and a few event-loop turns (real fs promises need them). */
export async function flushAsync(rounds: number = FLUSH_ROUNDS): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Clock + Timers whose time only moves through advance(). */
export class FakeClock implements Clock, Timers {
  private current: number;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  constructor(startMs: number = Date.UTC(2026, 8, 25, 12, 0, 0)) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    return this.add(fn, Math.max(0, ms), null);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    if (ms <= 0) throw new Error('FakeClock: interval must be > 0');
    return this.add(fn, ms, ms);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }

  /** Timers still scheduled (tests assert cleanup). */
  pending(): number {
    return this.timers.length;
  }

  /** Moves time forward, firing due timers in order and flushing async work after each. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.earliestDue(target);
      if (due === null) break;
      this.current = due.at;
      this.fire(due);
      await flushAsync();
    }
    this.current = target;
    await flushAsync();
  }

  private add(fn: () => void, ms: number, every: number | null): TimerHandle {
    const timer: FakeTimer = { id: this.nextId++, at: this.current + ms, fn, every };
    this.timers.push(timer);
    return { cancel: () => this.remove(timer.id) };
  }

  private remove(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  private earliestDue(target: number): FakeTimer | null {
    let best: FakeTimer | null = null;
    for (const t of this.timers) {
      if (t.at > target) continue;
      if (best === null || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }

  private fire(t: FakeTimer): void {
    if (t.every === null) this.remove(t.id);
    else t.at += t.every;
    t.fn();
  }
}

// ---------- Logger and emitter ----------

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly meta: LogMeta | undefined;
}

export class MemoryLogger implements SyncLogger {
  readonly entries: LogEntry[] = [];

  debug(message: string, meta?: LogMeta): void {
    this.entries.push({ level: 'debug', message, meta });
  }

  info(message: string, meta?: LogMeta): void {
    this.entries.push({ level: 'info', message, meta });
  }

  warn(message: string, meta?: LogMeta): void {
    this.entries.push({ level: 'warn', message, meta });
  }

  error(message: string, meta?: LogMeta): void {
    this.entries.push({ level: 'error', message, meta });
  }

  messages(level?: LogEntry['level']): string[] {
    return this.entries.filter((e) => level === undefined || e.level === level).map((e) => e.message);
  }

  /** Messages that do not start with one of `prefixes` (should be empty). */
  unprefixed(prefixes: readonly string[] = ['[sync]', '[vault-session]']): string[] {
    return this.entries.map((e) => e.message).filter((m) => !prefixes.some((p) => m.startsWith(p)));
  }
}

export class RecordingEmitter<M> implements RendererEmitter<M> {
  readonly events: { readonly channel: keyof M & string; readonly payload: unknown }[] = [];

  emit<K extends keyof M & string>(channel: K, payload: M[K]): void {
    this.events.push({ channel, payload });
  }

  of<K extends keyof M & string>(channel: K): M[K][] {
    return this.events.filter((e) => e.channel === channel).map((e) => e.payload as M[K]);
  }

  last<K extends keyof M & string>(channel: K): M[K] | undefined {
    const all = this.of(channel);
    return all[all.length - 1];
  }
}

// ---------- File system with fault injection ----------

export type FsOp = Exclude<keyof SyncFs, 'watchDir'>;

export interface FaultRule {
  readonly op: FsOp;
  /** Matched against the first path argument; omitted matches every path. */
  readonly match?: RegExp;
  readonly code: string;
  /** How many calls fail (default 1); Infinity for every call. */
  times?: number;
}

export function errnoError(code: string, message: string = code): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** Real Node fs underneath; inject() makes matching calls reject with an errno error. */
export class FaultyFs implements SyncFs {
  readonly calls: { readonly op: FsOp; readonly path: string }[] = [];
  private readonly rules: FaultRule[] = [];

  constructor(private readonly base: SyncFs = createNodeSyncFs()) {}

  inject(rule: FaultRule): void {
    this.rules.push({ ...rule, times: rule.times ?? 1 });
  }

  clearFaults(): void {
    this.rules.length = 0;
  }

  readFile = (p: string) => this.run('readFile', p, () => this.base.readFile(p));
  writeFile = (p: string, d: Uint8Array | string) => this.run('writeFile', p, () => this.base.writeFile(p, d));
  writeFileDurable = (p: string, d: Uint8Array | string, mode?: number) =>
    this.run('writeFileDurable', p, () => this.base.writeFileDurable(p, d, mode));
  stat = (p: string) => this.run('stat', p, () => this.base.stat(p));
  lstat = (p: string) => this.run('lstat', p, () => this.base.lstat(p));
  realpath = (p: string) => this.run('realpath', p, () => this.base.realpath(p));
  readdir = (p: string) => this.run('readdir', p, () => this.base.readdir(p));
  rename = (a: string, b: string) => this.run('rename', a, () => this.base.rename(a, b));
  copyFile = (a: string, b: string) => this.run('copyFile', a, () => this.base.copyFile(a, b));
  rm = (p: string, o: { readonly recursive: boolean; readonly force: boolean }) => this.run('rm', p, () => this.base.rm(p, o));
  mkdir = (p: string) => this.run('mkdir', p, () => this.base.mkdir(p));
  utimes = (p: string, a: number, m: number) => this.run('utimes', p, () => this.base.utimes(p, a, m));
  fsyncDir = (p: string) => this.run('fsyncDir', p, () => this.base.fsyncDir(p));
  watchDir: SyncFs['watchDir'] = (dir, onEvent, onError) => this.base.watchDir(dir, onEvent, onError);

  private async run<T>(op: FsOp, p: string, fn: () => Promise<T>): Promise<T> {
    this.calls.push({ op, path: p });
    const rule = this.rules.find((r) => r.op === op && (r.times ?? 0) > 0 && (r.match === undefined || r.match.test(p)));
    if (rule !== undefined) {
      rule.times = (rule.times ?? 1) - 1;
      throw errnoError(rule.code, `${op} ${p}`);
    }
    return fn();
  }
}

// ---------- Shell, kdf, providers ----------

/** Moves "trashed" files into `trashDir` and records them. */
export class FakeShell implements ShellHost {
  readonly trashed: string[] = [];

  constructor(private readonly trashDir: string) {}

  async trashItem(p: string): Promise<void> {
    fs.mkdirSync(this.trashDir, { recursive: true });
    fs.renameSync(p, path.join(this.trashDir, `${this.trashed.length}-${path.basename(p)}`));
    this.trashed.push(p);
  }
}

/** Fast deterministic stand-in for PBKDF2 (tests that open files with ConduitVault need realKdf). */
export const fastKdf: Kdf = {
  deriveKey: (password, saltB64) => crypto.createHmac('sha256', Buffer.from(saltB64, 'base64')).update(password, 'utf8').digest(),
};

export const TEST_DEVICE: DeviceInfo = { name: 'Test Mac', platform: 'macos', appVersion: '0.18.0' };

export const permissiveApp: AppFacts = {
  settingsListsVault: () => false,
  thisBuildFirstLaunchMs: () => null,
};

// ---------- Working copy stand-in ----------

export interface MutationRecord {
  readonly info: VaultMutationInfo;
}

/** A WorkingCopyHandle over a raw better-sqlite3 connection, recording what the sync layer asks. */
export class TestWorkingCopy implements WorkingCopyHandle {
  readonly keys: Buffer[] = [];
  readonly changed: RowKey[][] = [];
  hooks: VaultSyncHooks | null = null;
  closed = false;

  constructor(
    readonly db: Database.Database,
    key: Buffer,
  ) {
    this.keys.push(key);
  }

  setKey(key: Buffer): void {
    this.keys.push(key);
  }

  setHooks(hooks: VaultSyncHooks | null): void {
    this.hooks = hooks;
  }

  contentChanged(rows: readonly RowKey[]): void {
    this.changed.push([...rows]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.db.open) this.db.close();
  }

  /** What ConduitVault does around a mutator: writes and capture in one transaction, then afterCommit. */
  mutate(write: (db: Database.Database) => void, info: VaultMutationInfo): void {
    this.db.transaction(() => {
      write(this.db);
      this.hooks?.captureInTransaction(info);
    })();
    this.hooks?.afterCommit(info);
  }
}

export class TestWorkingCopyHost implements WorkingCopyHost {
  readonly opened: TestWorkingCopy[] = [];

  open(input: WorkingCopyOpenInput): TestWorkingCopy {
    const exists = fs.existsSync(input.path);
    if (input.create && exists) throw new Error('TestWorkingCopyHost: file already exists');
    if (!input.create && !exists) throw new Error('TestWorkingCopyHost: file not found');
    const db = new Database(input.path);
    db.pragma(`journal_mode = ${input.journalMode === 'wal' ? 'WAL' : 'DELETE'}`);
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec(CREATE_SCHEMA);
    db.prepare('INSERT OR IGNORE INTO vault_meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    const handle = new TestWorkingCopy(db, input.key);
    this.opened.push(handle);
    return handle;
  }

  last(): TestWorkingCopy {
    const h = this.opened[this.opened.length - 1];
    if (h === undefined) throw new Error('TestWorkingCopyHost: nothing opened');
    return h;
  }
}

// ---------- Bundle ----------

export interface TestSyncHost {
  readonly host: SyncHost;
  readonly clock: FakeClock;
  readonly logger: MemoryLogger;
  readonly events: RecordingEmitter<SyncEventMap>;
  readonly fs: FaultyFs;
  readonly shell: FakeShell;
  readonly workingCopy: TestWorkingCopyHost;
  /** Mutable test knobs read by the host's providers. */
  readonly knobs: { userId: string | null; personalSyncPaused: boolean; networkPrefixes: string[] };
}

/** A full SyncHost over a temp `root`: FakeClock, real fs with faults, fast kdf, test working copy. */
export function makeTestSyncHost(root: string, overrides: Partial<SyncHost> = {}): TestSyncHost {
  const clock = new FakeClock();
  const logger = new MemoryLogger();
  const events = new RecordingEmitter<SyncEventMap>();
  const faulty = new FaultyFs();
  const shell = new FakeShell(path.join(root, '.trash'));
  const workingCopy = new TestWorkingCopyHost();
  const knobs = { userId: null as string | null, personalSyncPaused: false, networkPrefixes: [] as string[] };
  const host: SyncHost = {
    clock,
    timers: clock,
    random: nodeRandom,
    kdf: fastKdf,
    logger,
    fs: faulty,
    events,
    paths: { platform: process.platform, isNetworkPath: (p) => knobs.networkPrefixes.some((x) => p.startsWith(x)) },
    shell,
    flags: { personalSyncPaused: () => knobs.personalSyncPaused },
    device: { current: () => TEST_DEVICE },
    account: { userId: () => knobs.userId },
    app: permissiveApp,
    workingCopy,
    ...overrides,
  };
  return { host, clock, logger, events, fs: faulty, shell, workingCopy, knobs };
}

/** mkdtemp under the OS temp folder; remove with fs.rmSync(dir, { recursive: true, force: true }). */
export function makeTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `conduit-${label}-`));
}
