// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LINEAGE_DIRS,
  ensureLineageDirs,
  ensurePrivateRoot,
  isInsideDir,
  isNetworkRoot,
  isPublishTempName,
  isSharedVault,
  lineagePaths,
  machineDir,
  machineFolderName,
  pathEnvFrom,
  publishTempName,
  realpathOfNearest,
  resolveVaultLocation,
  sideFilesDirName,
  syncRoot,
  writeFileAtomic,
  type PathEnv,
} from '../paths.js';

const HINT = 'abcdef0123456789'.repeat(4);
const LINEAGE = '0b1f6f3e-4a1c-5d7e-9f00-1234567890ab';

function env(over: Partial<PathEnv>): PathEnv {
  return {
    platform: 'linux',
    home: '/home/u',
    appDataDir: '/home/u/.config',
    localAppData: null,
    xdgStateHome: null,
    appFolder: 'Conduit',
    ...over,
  };
}

describe('syncRoot (3.2)', () => {
  it('uses Application Support/<app>/<env>/sync on macOS', () => {
    const e = env({ platform: 'darwin', home: '/Users/u', appDataDir: '/Users/u/Library/Application Support' });
    expect(syncRoot(e, 'conduit')).toBe('/Users/u/Library/Application Support/Conduit/conduit/sync');
    expect(syncRoot(e, 'conduit-dev')).toBe('/Users/u/Library/Application Support/Conduit/conduit-dev/sync');
  });

  it('uses LOCALAPPDATA\\Conduit\\<env>\\sync on Windows, never Roaming', () => {
    const e = env({
      platform: 'win32',
      home: 'C:\\Users\\u',
      appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
      localAppData: 'D:\\Profiles\\u\\Local',
    });
    expect(syncRoot(e, 'conduit')).toBe('D:\\Profiles\\u\\Local\\Conduit\\conduit\\sync');
    const noLocal = { ...e, localAppData: null };
    expect(syncRoot(noLocal, 'conduit-dev')).toBe('C:\\Users\\u\\AppData\\Local\\Conduit\\conduit-dev\\sync');
    expect(syncRoot(noLocal, 'conduit')).not.toContain('Roaming');
  });

  it('uses XDG_STATE_HOME or ~/.local/state on Linux', () => {
    expect(syncRoot(env({ xdgStateHome: '/xdg/state' }), 'conduit-dev')).toBe('/xdg/state/conduit/conduit-dev/sync');
    expect(syncRoot(env({}), 'conduit')).toBe('/home/u/.local/state/conduit/conduit/sync');
    expect(syncRoot(env({ platform: 'freebsd' }), 'conduit')).toBe('/home/u/.local/state/conduit/conduit/sync');
  });

  it('rejects empty inputs instead of building a relative root', () => {
    expect(() => syncRoot(env({ home: '' }), 'conduit')).toThrow(/home/);
    expect(() => syncRoot(env({ platform: 'darwin', appFolder: ' ' }), 'conduit')).toThrow(/appFolder/);
  });
});

describe('pathEnvFrom', () => {
  const base = { home: '/home/u', appDataDir: '/ad', appFolder: 'Conduit' };

  it('reads LOCALAPPDATA only on Windows', () => {
    const vars = { LOCALAPPDATA: 'C:\\L', XDG_STATE_HOME: '/x' };
    expect(pathEnvFrom({ ...base, platform: 'win32', env: vars })).toMatchObject({ localAppData: 'C:\\L', xdgStateHome: null });
    expect(pathEnvFrom({ ...base, platform: 'darwin', env: vars })).toMatchObject({ localAppData: null, xdgStateHome: null });
  });

  it('reads an absolute XDG_STATE_HOME and ignores relative or empty values', () => {
    expect(pathEnvFrom({ ...base, platform: 'linux', env: { XDG_STATE_HOME: '/x/state' } }).xdgStateHome).toBe('/x/state');
    expect(pathEnvFrom({ ...base, platform: 'linux', env: { XDG_STATE_HOME: 'rel/state' } }).xdgStateHome).toBeNull();
    expect(pathEnvFrom({ ...base, platform: 'linux', env: { XDG_STATE_HOME: '  ' } }).xdgStateHome).toBeNull();
    expect(pathEnvFrom({ ...base, platform: 'linux', env: {} }).xdgStateHome).toBeNull();
  });
});

describe('folder layout', () => {
  it('names the machine folder after the first 8 hex of hw_hint', () => {
    expect(machineFolderName(HINT)).toBe('m-abcdef01');
    expect(machineDir('/root/sync', HINT)).toBe(path.join('/root/sync', 'm-abcdef01'));
  });

  it.each(['abc', 'ABCDEF0123', '../../etc', 'abcdefg1', ''])('rejects hw_hint %j', (bad) => {
    expect(() => machineFolderName(bad)).toThrow();
  });

  it('lays out the lineage folder', () => {
    const p = lineagePaths('/m', LINEAGE);
    const d = path.join('/m', LINEAGE);
    expect(p).toEqual({
      dir: d,
      working: path.join(d, 'w.conduit'),
      local: path.join(d, 'local.json'),
      genesis: path.join(d, 'genesis.conduit'),
      incoming: path.join(d, 'incoming'),
      snapshots: path.join(d, 'snapshots'),
      quarantine: path.join(d, 'quarantine'),
      parked: path.join(d, 'parked'),
      exports: path.join(d, 'exports'),
      tmp: path.join(d, 'tmp'),
    });
  });

  it.each(['../x', 'a/b', 'a\\b', '', '.hidden'])('rejects lineage id %j', (bad) => {
    expect(() => lineagePaths('/m', bad)).toThrow();
  });

  it('names side-file and publish temp folders', () => {
    expect(sideFilesDirName(1700000000000)).toBe('sidefiles-1700000000000');
    expect(() => sideFilesDirName(-1)).toThrow();
    expect(() => sideFilesDirName(1.5)).toThrow();
    expect(publishTempName('Vault.conduit', 'a1b2')).toBe('.~Vault.conduit.a1b2.tmp');
    expect(() => publishTempName('dir/Vault.conduit', 'a1')).toThrow();
    expect(() => publishTempName('Vault.conduit', 'a/1')).toThrow();
    expect(isPublishTempName('.~Vault.conduit.a1b2.tmp')).toBe(true);
    expect(isPublishTempName('Vault.conduit')).toBe(false);
    expect(isPublishTempName('.~.tmp')).toBe(false);
  });

  it('leaves other apps\' temp files in the cloud folder alone', () => {
    expect(isPublishTempName('.~Vault.CONDUIT.ff00.tmp')).toBe(true);
    expect(isPublishTempName('.~Report.docx.tmp')).toBe(false);
    expect(isPublishTempName('.~notes.a1b2.tmp')).toBe(false);
    expect(isPublishTempName('.~Vault.conduit.a-b.tmp')).toBe(false);
    expect(isPublishTempName('.~Vault.conduit.tmp')).toBe(false);
  });
});

describe('shared versus private (3.2)', () => {
  const inside = { vaultRealpath: '/data/conduit/default.conduit', dataDirRealpath: '/data/conduit' };

  it('is private only inside the data folder, local, and not a symlink', () => {
    expect(isSharedVault({ ...inside, isSymlink: false, isLocalVolume: true, platform: 'linux' })).toBe(false);
    expect(isSharedVault({ ...inside, isSymlink: true, isLocalVolume: true, platform: 'linux' })).toBe(true);
    expect(isSharedVault({ ...inside, isSymlink: false, isLocalVolume: false, platform: 'linux' })).toBe(true);
    const outside = { ...inside, vaultRealpath: '/Users/u/Dropbox/Vault.conduit' };
    expect(isSharedVault({ ...outside, isSymlink: false, isLocalVolume: true, platform: 'linux' })).toBe(true);
  });

  it('compares whole path segments', () => {
    expect(isInsideDir('/data/conduit-old/v.conduit', '/data/conduit', 'linux')).toBe(false);
    expect(isInsideDir('/data/conduit/..hidden/v.conduit', '/data/conduit', 'linux')).toBe(true);
    expect(isInsideDir('/data/conduit/../other/v.conduit', '/data/conduit', 'linux')).toBe(false);
    expect(isInsideDir('/data/conduit', '/data/conduit', 'linux')).toBe(false);
  });

  it('ignores case on macOS and Windows only', () => {
    expect(isInsideDir('/Users/U/Library/Conduit/v.conduit', '/Users/u/library/conduit', 'darwin')).toBe(true);
    expect(isInsideDir('/Users/U/Library/Conduit/v.conduit', '/Users/u/library/conduit', 'linux')).toBe(false);
    expect(isInsideDir('C:\\Users\\U\\AppData\\Roaming\\Conduit\\conduit\\v.conduit', 'c:\\users\\u\\appdata\\roaming\\conduit\\conduit', 'win32')).toBe(true);
    expect(isInsideDir('D:\\Vaults\\v.conduit', 'C:\\Users\\u\\AppData', 'win32')).toBe(false);
  });
});

describe('file system checks', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-paths-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function file(rel: string): string {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    return p;
  }

  const local = (): boolean => false;

  it('resolves private and shared vaults by realpath', () => {
    const dataDir = path.join(tmp, 'data');
    const priv = file('data/default.conduit');
    const shared = file('cloud/Vault.conduit');
    expect(resolveVaultLocation(priv, dataDir, local)).toEqual({ realpath: priv, shared: false });
    expect(resolveVaultLocation(shared, dataDir, local)).toEqual({ realpath: shared, shared: true });
    expect(resolveVaultLocation(priv, dataDir, () => true).shared).toBe(true);
  });

  it('treats a symlinked vault as shared even when it points inside the data folder', () => {
    const dataDir = path.join(tmp, 'data');
    const target = file('data/real.conduit');
    const link = path.join(dataDir, 'link.conduit');
    fs.symlinkSync(target, link);
    const res = resolveVaultLocation(link, dataDir, local);
    expect(res.realpath).toBe(target);
    expect(res.shared).toBe(true);
  });

  it('follows symlinked parent folders to the real location', () => {
    const cloudFile = file('cloud/Vault.conduit');
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    fs.symlinkSync(path.join(tmp, 'cloud'), path.join(dataDir, 'linked'));
    const res = resolveVaultLocation(path.join(dataDir, 'linked', 'Vault.conduit'), dataDir, local);
    expect(res).toEqual({ realpath: cloudFile, shared: true });
  });

  it('propagates a missing vault', () => {
    expect(() => resolveVaultLocation(path.join(tmp, 'nope.conduit'), tmp, local)).toThrow(/ENOENT/);
  });

  it('checks the network flag against the realpath of the nearest existing ancestor', () => {
    fs.mkdirSync(path.join(tmp, 'real'));
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'alias'));
    const seen = vi.fn((p: string) => p.startsWith(path.join(tmp, 'real')));
    expect(isNetworkRoot(path.join(tmp, 'alias', 'not', 'yet', 'sync'), seen)).toBe(true);
    expect(seen).toHaveBeenCalledWith(path.join(tmp, 'real', 'not', 'yet', 'sync'));
    expect(realpathOfNearest(path.join(tmp, 'alias'))).toBe(path.join(tmp, 'real'));
  });

  it('creates every lineage folder', () => {
    const p = lineagePaths(path.join(tmp, 'm-abcdef01'), LINEAGE);
    ensureLineageDirs(p);
    ensureLineageDirs(p);
    for (const d of Object.values(LINEAGE_DIRS)) expect(fs.statSync(path.join(p.dir, d)).isDirectory()).toBe(true);
  });

  it('writes atomically and leaves no temp files', () => {
    const target = path.join(tmp, 'a.json');
    writeFileAtomic(target, 'one');
    writeFileAtomic(target, Buffer.from('two'));
    expect(fs.readFileSync(target, 'utf8')).toBe('two');
    expect(fs.readdirSync(tmp)).toEqual(['a.json']);
  });

  it.skipIf(process.platform === 'win32')('keeps sync data owner-only', () => {
    const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
    const root = path.join(tmp, 'state', 'conduit', 'dev', 'sync');
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    fs.chmodSync(root, 0o755);
    expect(ensurePrivateRoot(root)).toBeNull();
    expect(modeOf(root)).toBe(0o700);
    const p = lineagePaths(path.join(root, 'm-abcdef01'), LINEAGE);
    ensureLineageDirs(p);
    expect(modeOf(p.dir)).toBe(0o700);
    expect(modeOf(p.exports)).toBe(0o700);
    writeFileAtomic(p.local, '{}');
    expect(modeOf(p.local)).toBe(0o600);
  });

  it('fails without leaving a temp file when the target cannot be replaced', () => {
    const target = path.join(tmp, 'dir-target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep'), 'x');
    expect(() => writeFileAtomic(target, 'x')).toThrow();
    expect(fs.readdirSync(tmp)).toEqual(['dir-target']);
    expect(() => writeFileAtomic(path.join(tmp, 'missing', 'f.json'), 'x')).toThrow(/ENOENT/);
  });
});
