// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from '../../../ipc/__tests__/sync-fakes.js';
import { AUTO_UNLOCK_SUFFIX, createAutoUnlockStore, type AutoUnlockStoreDeps, type SafeStorageLike } from '../auto-unlock-store.js';
import { vaultLineageToKey } from '../biometric-keys.js';

interface FakeSafeStorage extends SafeStorageLike {
  available: boolean;
  backend: string;
  failDecrypt: boolean;
}

function fakeSafeStorage(): FakeSafeStorage {
  const s: FakeSafeStorage = {
    available: true,
    backend: 'gnome_libsecret',
    failDecrypt: false,
    isEncryptionAvailable: () => s.available,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decryptString: (buf) => {
      if (s.failDecrypt) throw new Error('decrypt failed');
      return Buffer.from(buf.toString().slice(4), 'base64').toString();
    },
    getSelectedStorageBackend: () => s.backend,
  };
  return s;
}

let root: string;
let safe: FakeSafeStorage;
let excluded: string[];

function deps(over: Partial<AutoUnlockStoreDeps> = {}): AutoUnlockStoreDeps {
  return {
    safeStorage: safe,
    platform: 'darwin',
    env: {},
    dataDir: () => path.join(root, 'conduit', 'conduit-dev'),
    excludeFromBackup: async (d) => {
      excluded.push(d);
    },
    now: () => 1_000,
    ...over,
  };
}

function entryFile(lineageId: string): string {
  return path.join(root, 'conduit', 'conduit-dev', 'auto-unlock', `${vaultLineageToKey(lineageId)}${AUTO_UNLOCK_SUFFIX}`);
}

beforeEach(() => {
  silenceConsole();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-unlock-'));
  safe = fakeSafeStorage();
  excluded = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('secret store status (spec 3.2)', () => {
  it('macOS and Windows follow isEncryptionAvailable', () => {
    expect(createAutoUnlockStore(deps()).status()).toMatchObject({ usable: true, backend: 'keychain', storeName: 'system keychain' });
    const win = createAutoUnlockStore(deps({ platform: 'win32', env: { LOCALAPPDATA: root } }));
    expect(win.status()).toMatchObject({ usable: true, backend: 'dpapi', storeName: 'Windows credential store' });
    safe.available = false;
    expect(win.status()).toMatchObject({ usable: false, reason: 'unavailable' });
  });

  it('Linux refuses basic_text and unknown and accepts the four keyrings', () => {
    const store = createAutoUnlockStore(deps({ platform: 'linux' }));
    for (const backend of ['basic_text', 'unknown']) {
      safe.backend = backend;
      expect(store.status()).toMatchObject({ usable: false, reason: 'weak', storeName: 'system keyring' });
    }
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      safe.backend = backend;
      expect(store.status().usable).toBe(true);
    }
  });

  it('is read on every call, never cached', () => {
    const spy = vi.spyOn(safe, 'isEncryptionAvailable');
    const store = createAutoUnlockStore(deps());
    store.status();
    store.status();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('Windows without LOCALAPPDATA is not usable', () => {
    expect(createAutoUnlockStore(deps({ platform: 'win32', env: {} })).status().usable).toBe(false);
  });
});

describe('seal and read (spec 3.3)', () => {
  it('round-trips and binds the user id', async () => {
    const store = createAutoUnlockStore(deps());
    expect(await store.sealPassword('L1', 'user-a', 'pw-1')).toEqual({ ok: true });
    expect(store.readPassword('L1')).toEqual({ kind: 'ok', password: 'pw-1', userId: 'user-a' });
    expect(store.hasEntry('L1')).toBe(true);
    expect(store.readPassword('L2')).toEqual({ kind: 'missing' });
  });

  it('writes the file 0600 in a 0700 folder and excludes the folder from Time Machine once', async () => {
    const store = createAutoUnlockStore(deps());
    await store.sealPassword('L1', null, 'pw');
    await store.sealPassword('L1', null, 'pw2');
    expect(fs.statSync(entryFile('L1')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(entryFile('L1'))).mode & 0o777).toBe(0o700);
    expect(excluded).toEqual([path.dirname(entryFile('L1'))]);
  });

  it('a failed Time Machine exclusion does not block the seal', async () => {
    const store = createAutoUnlockStore(deps({ excludeFromBackup: async () => { throw new Error('tmutil'); } }));
    expect(await store.sealPassword('L1', null, 'pw')).toEqual({ ok: true });
  });

  it('keeps the old file when the rename fails', async () => {
    const store = createAutoUnlockStore(deps());
    await store.sealPassword('L1', null, 'old');
    const failing = { ...fs, renameSync: () => { throw new Error('rename'); } } as unknown as typeof fs;
    const broken = createAutoUnlockStore(deps({ fs: failing }));
    expect(await broken.sealPassword('L1', null, 'new')).toEqual({ ok: false, reason: 'write-failed' });
    expect(store.readPassword('L1')).toMatchObject({ kind: 'ok', password: 'old' });
    expect(fs.existsSync(`${entryFile('L1')}.tmp`)).toBe(false);
  });

  it('sealing B removes A, and removeAllExcept keeps only the named entry', async () => {
    const store = createAutoUnlockStore(deps());
    await store.sealPassword('A', null, 'a');
    await store.sealPassword('B', null, 'b');
    expect(store.hasEntry('A')).toBe(false);
    expect(store.hasEntry('B')).toBe(true);
    fs.writeFileSync(entryFile('C'), 'x');
    expect(store.removeAllExcept('B')).toBe(1);
    expect(store.hasEntry('B')).toBe(true);
    expect(store.removeAllExcept(null)).toBe(1);
    expect(store.hasEntry('B')).toBe(false);
  });

  it('reads an unknown version, another lineage or another backend as unreadable and keeps the file', async () => {
    const store = createAutoUnlockStore(deps());
    const write = (envelope: object) => fs.writeFileSync(entryFile('L1'), safe.encryptString(JSON.stringify(envelope)));
    await store.sealPassword('L1', null, 'pw');
    write({ v: 2, lineageId: 'L1', userId: null, backend: 'keychain', password: 'pw' });
    expect(store.readPassword('L1')).toEqual({ kind: 'unreadable' });
    write({ v: 1, lineageId: 'L9', userId: null, backend: 'keychain', password: 'pw' });
    expect(store.readPassword('L1')).toEqual({ kind: 'unreadable' });
    write({ v: 1, lineageId: 'L1', userId: null, backend: 'basic_text', password: 'pw' });
    expect(store.readPassword('L1')).toEqual({ kind: 'unreadable' });
    expect(fs.existsSync(entryFile('L1'))).toBe(true);
  });

  it('a decrypt failure is unreadable and keeps the file', async () => {
    const store = createAutoUnlockStore(deps());
    await store.sealPassword('L1', null, 'pw');
    safe.failDecrypt = true;
    expect(store.readPassword('L1')).toEqual({ kind: 'unreadable' });
    expect(store.hasEntry('L1')).toBe(true);
  });

  it('a re-seal under basic_text writes nothing and removes the old entry', async () => {
    const store = createAutoUnlockStore(deps({ platform: 'linux' }));
    await store.sealPassword('L1', null, 'pw');
    safe.backend = 'basic_text';
    expect(await store.sealPassword('L1', null, 'new')).toEqual({ ok: false, reason: 'weak' });
    expect(store.hasEntry('L1')).toBe(false);
  });
});

describe('location (spec 3.3)', () => {
  it('Windows keeps entries under LOCALAPPDATA, not the roaming data dir', async () => {
    const local = path.join(root, 'Local');
    const store = createAutoUnlockStore(deps({ platform: 'win32', env: { LOCALAPPDATA: local } }));
    expect(store.dir()).toBe(path.join(local, 'conduit', 'conduit-dev', 'auto-unlock'));
    await store.sealPassword('L1', null, 'pw');
    expect(fs.readdirSync(path.join(local, 'conduit', 'conduit-dev', 'auto-unlock'))).toHaveLength(1);
    expect(excluded).toEqual([]);
  });
});
