/**
 * Node adapters for the sync host (host.ts): fs.promises file access with bigint inodes,
 * the system clock and timers, crypto randomness and a console logger. No Electron import;
 * the integration adds the Electron-only adapters (working copy, renderer events, shell).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { isErrno } from './paths.js';
import type { Clock, FileStat, LogMeta, Random, SyncFs, SyncLogger, TimerHandle, Timers } from './host.js';

/** Sync data holds vault copies: owner-only unless the caller copies another file's mode. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
const PERMISSION_BITS = 0o7777;

/** Cloud and network file systems that ignore permission bits refuse chmod; the write still counts. */
const CHMOD_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'ENOSYS']);

/** Directory fsync is unsupported on Windows and on some network file systems. */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EBADF']);

function toStat(s: fs.BigIntStats): FileStat {
  return {
    size: Number(s.size),
    mtimeMs: Number(s.mtimeMs),
    ino: s.ino.toString(),
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    mode: Number(s.mode) & PERMISSION_BITS,
  };
}

async function statOrNull(fn: () => Promise<fs.BigIntStats>): Promise<FileStat | null> {
  try {
    return toStat(await fn());
  } catch (err) {
    if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) return null;
    throw err;
  }
}

async function writeDurable(p: string, data: Uint8Array | string, mode?: number): Promise<void> {
  const handle = await fsp.open(p, 'w', mode ?? PRIVATE_FILE_MODE);
  try {
    if (mode !== undefined) await applyMode(handle, mode);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** open() masks the mode with the umask and ignores it for an existing file, so it is set again. */
async function applyMode(handle: fsp.FileHandle, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await handle.chmod(mode);
  } catch (err) {
    if (!CHMOD_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (!DIR_FSYNC_UNSUPPORTED.has(code)) throw err;
  } finally {
    if (handle !== null) await handle.close();
  }
}

export function createNodeSyncFs(): SyncFs {
  return {
    readFile: (p) => fsp.readFile(p),
    writeFile: (p, data) => fsp.writeFile(p, data),
    writeFileDurable: writeDurable,
    stat: (p) => statOrNull(() => fsp.stat(p, { bigint: true })),
    lstat: (p) => statOrNull(() => fsp.lstat(p, { bigint: true })),
    realpath: (p) => fsp.realpath(p),
    readdir: (dir) => fsp.readdir(dir),
    rename: (from, to) => fsp.rename(from, to),
    copyFile: (from, to) => fsp.copyFile(from, to),
    rm: (p, opts) => fsp.rm(p, { recursive: opts.recursive, force: opts.force }),
    mkdir: async (p) => {
      await fsp.mkdir(p, { recursive: true, mode: PRIVATE_DIR_MODE });
    },
    utimes: (p, atimeMs, mtimeMs) => fsp.utimes(p, atimeMs / 1000, mtimeMs / 1000),
    fsyncDir,
    watchDir(dir, onEvent, onError) {
      const watcher = fs.watch(dir, { persistent: false }, (type, name) => {
        onEvent(type === 'change' ? 'change' : 'rename', name === null ? null : String(name));
      });
      watcher.on('error', (err) => onError(err));
      return { close: () => watcher.close() };
    },
  };
}

export const systemClock: Clock = { now: () => Date.now() };

export function createNodeTimers(): Timers {
  return {
    setTimeout(fn, ms): TimerHandle {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    },
    setInterval(fn, ms): TimerHandle {
      const t = setInterval(fn, ms);
      t.unref?.();
      return { cancel: () => clearInterval(t) };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export const nodeRandom: Random = {
  bytes: (n) => crypto.randomBytes(n),
  uuid: () => crypto.randomUUID(),
};

/** Console logger; callers already prefix messages with [sync] or [vault-session]. */
export function createConsoleLogger(): SyncLogger {
  const line = (message: string, meta?: LogMeta): unknown[] => (meta === undefined ? [message] : [message, meta]);
  return {
    debug: (m, meta) => console.debug(...line(m, meta)),
    info: (m, meta) => console.info(...line(m, meta)),
    warn: (m, meta) => console.warn(...line(m, meta)),
    error: (m, meta) => console.error(...line(m, meta)),
  };
}
