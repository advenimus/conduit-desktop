/**
 * Saved unlock for the startup vault (docs/AUTO_UNLOCK.md 3): the master password sealed with the
 * OS secret store (Electron safeStorage), keyed by vault lineage, at most one entry per computer.
 * The status is read fresh on every call and every seal checks it, so a weak Linux backend never
 * gets a new entry. Nothing here ever returns the password over IPC; callers stay in main.
 */

import fs from 'node:fs';
import path from 'node:path';
import { vaultLineageToKey } from './biometric-keys.js';

export const AUTO_UNLOCK_SUFFIX = '.auto.enc';
const ENVELOPE_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LINUX_KEYRINGS: ReadonlySet<string> = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
const LOG = '[auto-unlock]';

export type SecretStoreReason = 'ok' | 'unavailable' | 'weak';

export interface SecretStoreStatus {
  readonly usable: boolean;
  readonly reason: SecretStoreReason;
  /** 'keychain', 'dpapi', or the Linux backend name. */
  readonly backend: string;
  /** How the UI names the store: "system keychain", "Windows credential store", "system keyring". */
  readonly storeName: string;
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface AutoUnlockStoreDeps {
  readonly safeStorage: SafeStorageLike;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** getDataDir(): `{appData}/{app}/{env folder}`. */
  dataDir(): string;
  /** macOS: keep the folder out of Time Machine and Migration Assistant. Best effort. */
  excludeFromBackup(dir: string): Promise<void>;
  now(): number;
  readonly fs?: typeof fs;
}

interface AutoUnlockEnvelope {
  readonly v: number;
  readonly lineageId: string;
  readonly userId: string | null;
  readonly backend: string;
  readonly password: string;
  readonly sealedAt: number;
}

export type ReadResult =
  | { readonly kind: 'ok'; readonly password: string; readonly userId: string | null }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' };

export type SealResult = { readonly ok: true } | { readonly ok: false; readonly reason: SecretStoreReason | 'write-failed' };

export interface AutoUnlockStore {
  status(): SecretStoreStatus;
  dir(): string | null;
  sealPassword(lineageId: string, userId: string | null, password: string): Promise<SealResult>;
  readPassword(lineageId: string): ReadResult;
  hasEntry(lineageId: string): boolean;
  removeEntry(lineageId: string): boolean;
  /** Returns how many entries it removed. */
  removeAll(): number;
  removeAllExcept(lineageId: string | null): number;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

function storeNameFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'system keychain';
  if (platform === 'win32') return 'Windows credential store';
  return 'system keyring';
}

function backendFor(deps: AutoUnlockStoreDeps): string {
  if (deps.platform === 'darwin') return 'keychain';
  if (deps.platform === 'win32') return 'dpapi';
  try {
    return deps.safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function available(deps: AutoUnlockStoreDeps): boolean {
  try {
    return deps.safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function parseEnvelope(text: string): AutoUnlockEnvelope | null {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.v !== 'number' || typeof e.lineageId !== 'string' || typeof e.backend !== 'string' || typeof e.password !== 'string') return null;
  if (e.userId !== null && typeof e.userId !== 'string') return null;
  return { v: e.v, lineageId: e.lineageId, userId: e.userId as string | null, backend: e.backend, password: e.password, sealedAt: Number(e.sealedAt) || 0 };
}

export function createAutoUnlockStore(deps: AutoUnlockStoreDeps): AutoUnlockStore {
  const io = deps.fs ?? fs;

  const status = (): SecretStoreStatus => {
    const backend = backendFor(deps);
    const storeName = storeNameFor(deps.platform);
    if (!available(deps)) return { usable: false, reason: 'unavailable', backend, storeName };
    if (deps.platform === 'win32' && !deps.env.LOCALAPPDATA) return { usable: false, reason: 'unavailable', backend, storeName };
    if (deps.platform !== 'darwin' && deps.platform !== 'win32' && !LINUX_KEYRINGS.has(backend)) {
      return { usable: false, reason: 'weak', backend, storeName };
    }
    return { usable: true, reason: 'ok', backend, storeName };
  };

  // Windows: under %LOCALAPPDATA%, which never roams with the profile (spec 3.3).
  const dir = (): string | null => {
    const dataDir = deps.dataDir();
    if (deps.platform !== 'win32') return path.join(dataDir, 'auto-unlock');
    const local = deps.env.LOCALAPPDATA;
    if (!local) return null;
    return path.join(local, path.basename(path.dirname(dataDir)), path.basename(dataDir), 'auto-unlock');
  };

  const fileFor = (lineageId: string): string | null => {
    const d = dir();
    return d === null ? null : path.join(d, `${vaultLineageToKey(lineageId)}${AUTO_UNLOCK_SUFFIX}`);
  };

  const entries = (): string[] => {
    const d = dir();
    if (d === null) return [];
    try {
      if (!io.existsSync(d)) return [];
      return io.readdirSync(d).filter((f) => f.endsWith(AUTO_UNLOCK_SUFFIX) || f.endsWith(`${AUTO_UNLOCK_SUFFIX}.tmp`)).map((f) => path.join(d, f));
    } catch (err) {
      console.warn(`${LOG} could not list saved unlocks`, { name: errName(err) });
      return [];
    }
  };

  const removeFiles = (files: readonly string[]): number => {
    let removed = 0;
    for (const f of files) {
      try {
        io.rmSync(f, { force: true });
        if (f.endsWith(AUTO_UNLOCK_SUFFIX)) removed += 1;
      } catch (err) {
        console.warn(`${LOG} could not remove a saved unlock`, { name: errName(err) });
      }
    }
    return removed;
  };

  const removeAll = (): number => removeFiles(entries());

  const removeAllExcept = (lineageId: string | null): number => {
    const keep = lineageId === null ? null : fileFor(lineageId);
    return removeFiles(entries().filter((f) => f !== keep));
  };

  const ensureDir = async (d: string): Promise<void> => {
    const created = !io.existsSync(d);
    io.mkdirSync(d, { recursive: true, mode: DIR_MODE });
    if (deps.platform !== 'win32') io.chmodSync(d, DIR_MODE);
    if (created && deps.platform === 'darwin') {
      try {
        await deps.excludeFromBackup(d);
      } catch (err) {
        console.warn(`${LOG} could not exclude the saved unlock folder from Time Machine`, { name: errName(err) });
      }
    }
  };

  const writeAtomic = (file: string, bytes: Buffer): void => {
    const tmp = `${file}.tmp`;
    const fd = io.openSync(tmp, 'w', FILE_MODE);
    try {
      io.writeSync(fd, bytes);
      io.fsyncSync(fd);
    } finally {
      io.closeSync(fd);
    }
    if (deps.platform !== 'win32') io.chmodSync(tmp, FILE_MODE);
    io.renameSync(tmp, file);
  };

  const sealPassword = async (lineageId: string, userId: string | null, password: string): Promise<SealResult> => {
    const s = status();
    const file = fileFor(lineageId);
    if (!s.usable || file === null) {
      removeAll();
      console.warn(`${LOG} saved unlock refused: the secret store is not usable`, { reason: s.reason, backend: s.backend });
      return { ok: false, reason: s.reason };
    }
    try {
      await ensureDir(path.dirname(file));
      const envelope: AutoUnlockEnvelope = { v: ENVELOPE_VERSION, lineageId, userId, backend: s.backend, password, sealedAt: deps.now() };
      writeAtomic(file, deps.safeStorage.encryptString(JSON.stringify(envelope)));
      removeAllExcept(lineageId);
      console.info(`${LOG} saved unlock stored`, { backend: s.backend });
      return { ok: true };
    } catch (err) {
      console.error(`${LOG} saved unlock could not be written`, { name: errName(err) });
      try {
        io.rmSync(`${file}.tmp`, { force: true });
      } catch {
        // Best effort: the next seal or start removes stray temp files.
      }
      return { ok: false, reason: 'write-failed' };
    }
  };

  const readPassword = (lineageId: string): ReadResult => {
    const file = fileFor(lineageId);
    if (file === null || !io.existsSync(file)) return { kind: 'missing' };
    try {
      const envelope = parseEnvelope(deps.safeStorage.decryptString(io.readFileSync(file)));
      if (envelope === null || envelope.v !== ENVELOPE_VERSION || envelope.lineageId !== lineageId || envelope.backend !== backendFor(deps)) {
        console.warn(`${LOG} saved unlock does not match this vault or store; kept`);
        return { kind: 'unreadable' };
      }
      return { kind: 'ok', password: envelope.password, userId: envelope.userId };
    } catch (err) {
      console.warn(`${LOG} saved unlock could not be read; kept`, { name: errName(err) });
      return { kind: 'unreadable' };
    }
  };

  const hasEntry = (lineageId: string): boolean => {
    const file = fileFor(lineageId);
    try {
      return file !== null && io.existsSync(file);
    } catch {
      return false;
    }
  };

  const removeEntry = (lineageId: string): boolean => {
    const file = fileFor(lineageId);
    return file !== null && removeFiles([file]) > 0;
  };

  return { status, dir, sealPassword, readPassword, hasEntry, removeEntry, removeAll, removeAllExcept };
}
