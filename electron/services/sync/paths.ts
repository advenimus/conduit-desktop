/**
 * Machine-local sync paths (spec 3.2): syncRoot per platform, the per-machine folder
 * m-<first 8 hex of hw_hint>, the per-lineage folder layout, the shared-versus-private
 * decision by realpath, the network-root check that switches W to journal_mode=DELETE, and
 * the atomic tmp+rename writer used for device.json, machine.json and local.json.
 * Pure path logic takes an injected PathEnv so tests never touch real app folders.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type EnvName = 'conduit' | 'conduit-dev';

/** Inputs for syncRoot(); callers fill these from Electron app.getPath and process.env. */
export interface PathEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Electron app.getPath('appData') (Roaming on Windows). */
  readonly appDataDir: string;
  /** %LOCALAPPDATA% on Windows, else null. */
  readonly localAppData: string | null;
  /** $XDG_STATE_HOME on Linux, else null. */
  readonly xdgStateHome: string | null;
  /** Electron app name folder used on macOS (e.g. 'Conduit' or 'Conduit Dev'). */
  readonly appFolder: string;
}

export const MACHINE_PREFIX = 'm-';
export const HW_PREFIX_LEN = 8;
export const SYNC_DIR = 'sync';

export const LINEAGE_FILES = {
  working: 'w.conduit',
  local: 'local.json',
  genesis: 'genesis.conduit',
  device: 'device.json',
  machine: 'machine.json',
} as const;

export const LINEAGE_DIRS = {
  incoming: 'incoming',
  snapshots: 'snapshots',
  quarantine: 'quarantine',
  parked: 'parked',
  exports: 'exports',
  tmp: 'tmp',
} as const;

export interface LineagePaths {
  readonly dir: string;
  readonly working: string;
  readonly local: string;
  readonly genesis: string;
  readonly incoming: string;
  readonly snapshots: string;
  readonly quarantine: string;
  readonly parked: string;
  readonly exports: string;
  readonly tmp: string;
}

const WIN_VENDOR_DIR = 'Conduit';
const LINUX_VENDOR_DIR = 'conduit';
const WIN_LOCAL_APPDATA_PARTS = ['AppData', 'Local'] as const;
const LINUX_STATE_PARTS = ['.local', 'state'] as const;
const SIDE_FILES_PREFIX = 'sidefiles-';
const SIDE_FILES_DIR_RE = new RegExp(`^${SIDE_FILES_PREFIX}\\d+$`);
const PUBLISH_TEMP_PREFIX = '.~';
const PUBLISH_TEMP_SUFFIX = '.tmp';
const TMP_SUFFIX_BYTES = 6;
/** Everything under syncRoot is a vault copy or its metadata: owner-only. */
export const SYNC_DIR_MODE = 0o700;
export const SYNC_FILE_MODE = 0o600;
const HEX_PREFIX_RE = new RegExp(`^[0-9a-f]{${HW_PREFIX_LEN},}$`);
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PUBLISH_RAND_RE = /^[A-Za-z0-9]+$/;
const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);
/** Directory fsync is unsupported on Windows and on some network file systems. */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES']);

// ---------- Roots ----------

export interface PathEnvSource {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly appDataDir: string;
  readonly appFolder: string;
  /** Usually process.env; only LOCALAPPDATA and XDG_STATE_HOME are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Builds a PathEnv from injected process values (no Electron import here). */
export function pathEnvFrom(src: PathEnvSource): PathEnv {
  const localAppData = src.platform === 'win32' ? nonEmpty(src.env.LOCALAPPDATA) : null;
  // XDG base directory spec: a relative value is invalid and must be ignored.
  const xdg = nonEmpty(src.env.XDG_STATE_HOME);
  const usesXdg = src.platform !== 'win32' && src.platform !== 'darwin';
  const xdgStateHome = usesXdg && xdg !== null && path.posix.isAbsolute(xdg) ? xdg : null;
  return {
    platform: src.platform,
    home: src.home,
    appDataDir: src.appDataDir,
    localAppData,
    xdgStateHome,
    appFolder: src.appFolder,
  };
}

/**
 * macOS: {appDataDir}/{appFolder}/{envName}/sync; Windows: {localAppData}\Conduit\{envName}\sync;
 * Linux: ${xdgStateHome:-~/.local/state}/conduit/{envName}/sync.
 */
export function syncRoot(env: PathEnv, envName: EnvName): string {
  if (env.platform === 'win32') {
    // Without LOCALAPPDATA, the Local folder under the profile; never Roaming (spec 3.2).
    const base = env.localAppData ?? path.win32.join(requireNonEmpty(env.home, 'home'), ...WIN_LOCAL_APPDATA_PARTS);
    return path.win32.join(base, WIN_VENDOR_DIR, envName, SYNC_DIR);
  }
  if (env.platform === 'darwin') {
    return path.posix.join(
      requireNonEmpty(env.appDataDir, 'appDataDir'),
      requireNonEmpty(env.appFolder, 'appFolder'),
      envName,
      SYNC_DIR,
    );
  }
  const base = env.xdgStateHome ?? path.posix.join(requireNonEmpty(env.home, 'home'), ...LINUX_STATE_PARTS);
  return path.posix.join(base, LINUX_VENDOR_DIR, envName, SYNC_DIR);
}

// ---------- Folder layout ----------

/** 'm-' + first 8 hex chars of hw_hint. */
export function machineFolderName(hwHint: string): string {
  if (!HEX_PREFIX_RE.test(hwHint)) {
    throw new Error(`paths: hw_hint must be lowercase hex of at least ${HW_PREFIX_LEN} chars`);
  }
  return MACHINE_PREFIX + hwHint.slice(0, HW_PREFIX_LEN);
}

export function machineDir(root: string, hwHint: string): string {
  return path.join(root, machineFolderName(hwHint));
}

export function lineagePaths(machineDirPath: string, lineageId: string): LineagePaths {
  if (!SAFE_SEGMENT_RE.test(lineageId)) throw new Error('paths: lineage id is not a safe folder name');
  const dir = path.join(machineDirPath, lineageId);
  return {
    dir,
    working: path.join(dir, LINEAGE_FILES.working),
    local: path.join(dir, LINEAGE_FILES.local),
    genesis: path.join(dir, LINEAGE_FILES.genesis),
    incoming: path.join(dir, LINEAGE_DIRS.incoming),
    snapshots: path.join(dir, LINEAGE_DIRS.snapshots),
    quarantine: path.join(dir, LINEAGE_DIRS.quarantine),
    parked: path.join(dir, LINEAGE_DIRS.parked),
    exports: path.join(dir, LINEAGE_DIRS.exports),
    tmp: path.join(dir, LINEAGE_DIRS.tmp),
  };
}

/** Creates the lineage folder and every subfolder of LINEAGE_DIRS (idempotent). */
export function ensureLineageDirs(p: LineagePaths): void {
  for (const dir of [p.dir, p.incoming, p.snapshots, p.quarantine, p.parked, p.exports, p.tmp]) {
    fs.mkdirSync(dir, { recursive: true, mode: SYNC_DIR_MODE });
  }
}

/**
 * Creates syncRoot owner-only and narrows an existing one: mkdir leaves existing folders alone,
 * and a 0700 root keeps every file below it (W, VACUUM INTO outputs, snapshots) private.
 * Returns the chmod error instead of throwing (some file systems refuse it; sync still works).
 */
export function ensurePrivateRoot(root: string): NodeJS.ErrnoException | null {
  fs.mkdirSync(root, { recursive: true, mode: SYNC_DIR_MODE });
  if (process.platform === 'win32') return null;
  try {
    fs.chmodSync(root, SYNC_DIR_MODE);
    return null;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
}

/** A 'sidefiles-<ts>' folder name. */
export function isSideFilesDirName(name: string): boolean {
  return SIDE_FILES_DIR_RE.test(name);
}

/** 'sidefiles-<ts>' folder name for moved-aside -wal/-shm (5.5). */
export function sideFilesDirName(timestampMs: number): string {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new Error('paths: side-files timestamp must be a non-negative integer');
  }
  return `${SIDE_FILES_PREFIX}${timestampMs}`;
}

/** Publish temp name next to S: '.~<name>.<rand>.tmp' (5.3). */
export function publishTempName(fileName: string, rand: string): string {
  if (fileName === '' || fileName !== path.basename(fileName) || /[\\/]/.test(fileName)) {
    throw new Error('paths: publish temp needs a plain file name');
  }
  if (!PUBLISH_RAND_RE.test(rand)) throw new Error('paths: publish temp random part must be alphanumeric');
  return `${PUBLISH_TEMP_PREFIX}${fileName}.${rand}${PUBLISH_TEMP_SUFFIX}`;
}

// '.~<name>.conduit.<rand>.tmp' only: other apps use '.~*.tmp' too, and start-up cleanup deletes matches.
const PUBLISH_TEMP_RE = /^\.~.+\.conduit\.[A-Za-z0-9]+\.tmp$/i;

/** True for names made by publishTempName (leftovers are removed at start-up, 5.3 step 6). */
export function isPublishTempName(name: string): boolean {
  return PUBLISH_TEMP_RE.test(name);
}

// ---------- Shared versus private ----------

export interface SharedDecisionInput {
  readonly vaultRealpath: string;
  readonly dataDirRealpath: string;
  /** lstat says the vault path itself is a symlink. */
  readonly isSymlink: boolean;
  readonly isLocalVolume: boolean;
  /** Decides path flavor and case sensitivity; defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
}

/** 3.2: private only when inside the data folder, on a local volume, and not a symlink. */
export function isSharedVault(input: SharedDecisionInput): boolean {
  if (input.isSymlink || !input.isLocalVolume) return true;
  return !isInsideDir(input.vaultRealpath, input.dataDirRealpath, input.platform ?? process.platform);
}

/** Path-segment aware containment: `/data-old/x` is not inside `/data`. */
export function isInsideDir(child: string, dir: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const fold = CASE_INSENSITIVE_PLATFORMS.has(platform) ? (s: string) => s.toLowerCase() : (s: string) => s;
  const rel = api.relative(fold(api.resolve(dir)), fold(api.resolve(child)));
  const escapes = rel === '..' || rel.startsWith(`..${api.sep}`);
  return rel !== '' && !escapes && !api.isAbsolute(rel);
}

/** Resolves realpath + lstat and applies isSharedVault. `isNetworkPath` is network-lock.ts's. */
export function resolveVaultLocation(
  vaultPath: string,
  dataDir: string,
  isNetworkPath: (p: string) => boolean,
): { readonly realpath: string; readonly shared: boolean } {
  const realpath = fs.realpathSync(vaultPath);
  const shared = isSharedVault({
    vaultRealpath: realpath,
    dataDirRealpath: realpathOfNearest(dataDir),
    isSymlink: fs.lstatSync(vaultPath).isSymbolicLink(),
    isLocalVolume: !isNetworkPath(realpath),
  });
  return { realpath, shared };
}

/** True when W must use journal_mode=DELETE because syncRoot resolves to a network path. */
export function isNetworkRoot(root: string, isNetworkPath: (p: string) => boolean): boolean {
  return isNetworkPath(realpathOfNearest(root));
}

/**
 * realpath of `p`, or, when `p` does not exist yet (syncRoot before first use), the realpath
 * of its nearest existing ancestor joined with the missing tail.
 */
export function realpathOfNearest(p: string): string {
  const missing: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...missing.reverse());
    } catch (err) {
      if (!isErrno(err, 'ENOENT') && !isErrno(err, 'ENOTDIR')) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ---------- Atomic writes ----------

/**
 * Writes `data` to `filePath` atomically: a temp file in the same folder, fsync, rename, then
 * a best-effort fsync of the folder so the rename itself survives a crash.
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(TMP_SUFFIX_BYTES).toString('hex')}.tmp`);
  try {
    writeAndSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    removeTempAfterFailure(tmp);
    throw err;
  }
  fsyncDir(dir);
}

function removeTempAfterFailure(tmp: string): void {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    // The caller receives the original write error; a leftover temp file is harmless.
  }
}

function writeAndSync(file: string, data: string | Uint8Array): void {
  const fd = fs.openSync(file, 'w', SYNC_FILE_MODE);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!DIR_FSYNC_UNSUPPORTED.has(errnoCode(err) ?? '')) throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// ---------- Helpers ----------

export function isErrno(err: unknown, code: string): boolean {
  return errnoCode(err) === code;
}

function errnoCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function nonEmpty(v: string | undefined): string | null {
  return v === undefined || v.trim() === '' ? null : v;
}

function requireNonEmpty(v: string, name: string): string {
  if (v.trim() === '') throw new Error(`paths: ${name} is empty`);
  return v;
}
