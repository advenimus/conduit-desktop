// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyPostgrestError } from '../../vault-session/host-electron-supabase.js';
import { DEV_DEVICE_LIMIT_ENV, devDeviceLimitOverride, devLimitCollaborators } from '../app-sync-dev.js';
import { InvalidSyncRequest, toFieldChoice, toRegKey, toRowKeys } from '../app-sync-dto-map.js';
import { BUILDS_FILE, envNameOf, recordFirstLaunch } from '../app-sync-identity.js';
import { idleLockMinutes, listedVaultPaths, personalSyncEnabled } from '../host-electron-settings.js';
import { devicePlatform, isCloudFolderPath } from '../host-electron.js';
import { MemoryLogger, makeTempRoot } from './host-fakes.js';

describe('dev device limit override', () => {
  it('is ignored when packaged or unset, and validated otherwise', () => {
    const logger = new MemoryLogger();
    expect(devDeviceLimitOverride(true, { [DEV_DEVICE_LIMIT_ENV]: '-1' }, logger)).toBeNull();
    expect(devDeviceLimitOverride(false, {}, logger)).toBeNull();
    expect(devDeviceLimitOverride(false, { [DEV_DEVICE_LIMIT_ENV]: '-1' }, logger)).toBe(-1);
    expect(devDeviceLimitOverride(false, { [DEV_DEVICE_LIMIT_ENV]: '2' }, logger)).toBe(2);
    expect(devDeviceLimitOverride(false, { [DEV_DEVICE_LIMIT_ENV]: '0' }, logger)).toBeNull();
    expect(devDeviceLimitOverride(false, { [DEV_DEVICE_LIMIT_ENV]: 'lots' }, logger)).toBeNull();
    expect(logger.unprefixed()).toEqual([]);
  });

  it('replaces the effective limit collaborator only when set', () => {
    expect(devLimitCollaborators(null)).toEqual({});
    const c = devLimitCollaborators(-1);
    expect(c.effectiveLimit?.({ signedIn: false, confirmed: false, serverLimit: null, localLast: null, tierCache: null, nowMs: 0 })).toEqual({
      limit: -1,
      source: 'default',
    });
  });
});

describe('settings readers', () => {
  it('defaults sync on and idle lock off', () => {
    expect(personalSyncEnabled({})).toBe(true);
    expect(personalSyncEnabled({ personal_sync_enabled: false })).toBe(false);
    expect(personalSyncEnabled({ personal_sync_enabled: 'no' })).toBe(true);
    expect(idleLockMinutes({ vault_idle_lock_minutes: 15 })).toBe(15);
    expect(idleLockMinutes({ vault_idle_lock_minutes: -3 })).toBe(0);
  });

  it('lists last and recent vault paths', () => {
    expect(listedVaultPaths({ last_vault_path: '/a.conduit', recent_vaults: ['/b.conduit', 3, ''] })).toEqual(['/a.conduit', '/b.conduit']);
  });
});

describe('paths and platform', () => {
  it('recognizes cloud folders the legacy test misses', () => {
    expect(isCloudFolderPath('/Users/me/Library/CloudStorage/GoogleDrive-me@x.com/My Drive/V.conduit')).toBe(true);
    expect(isCloudFolderPath('C:\\Users\\me\\iCloudDrive\\V.conduit')).toBe(true);
    expect(isCloudFolderPath('/home/me/Nextcloud/V.conduit')).toBe(true);
    expect(isCloudFolderPath('C:\\Users\\me\\OneDrive - Contoso\\V.conduit')).toBe(true);
    expect(isCloudFolderPath('/Users/me/Documents/V.conduit')).toBe(false);
  });

  it('maps platforms', () => {
    expect(devicePlatform('darwin')).toBe('macos');
    expect(devicePlatform('win32')).toBe('windows');
    expect(devicePlatform('linux')).toBe('linux');
  });
});

describe('rpc failure classification', () => {
  it('splits network, postgres and http failures', () => {
    expect(classifyPostgrestError({ message: 'fetch failed', code: '' }, 0)).toMatchObject({ ok: false, failure: { kind: 'network' } });
    expect(classifyPostgrestError({ message: 'bad', code: '23514' }, 400)).toMatchObject({ failure: { kind: 'postgres', code: '23514' } });
    expect(classifyPostgrestError({ message: 'no fn', code: 'PGRST202' }, 404)).toMatchObject({ failure: { kind: 'http', status: 404 } });
  });
});

describe('ipc input validation', () => {
  it('accepts well-formed keys and choices', () => {
    expect(toRegKey({ tbl: 1, rowId: 'e1', reg: 'host' })).toEqual({ tbl: 1, rowId: 'e1', reg: 'host' });
    expect(toRowKeys([{ tbl: 2, rowId: 'f1' }])).toEqual([{ tbl: 2, rowId: 'f1' }]);
    const both = toFieldChoice({ kind: 'keep-both', copyNames: { v1: 'Doc (from iPhone)' } });
    expect(both.kind === 'keep-both' && both.copyNames.get('v1')).toBe('Doc (from iPhone)');
  });

  it('rejects malformed input', () => {
    expect(() => toRegKey({ tbl: 7, rowId: 'e1', reg: 'host' })).toThrow(InvalidSyncRequest);
    expect(() => toRegKey({ tbl: 1, rowId: '', reg: 'host' })).toThrow(InvalidSyncRequest);
    expect(() => toFieldChoice({ kind: 'value', value: { x: 1 } })).toThrow(InvalidSyncRequest);
    expect(() => toRowKeys('nope')).toThrow(InvalidSyncRequest);
  });
});

describe('launch identity helpers', () => {
  let root: string | null = null;

  afterEach(() => {
    if (root !== null) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('reads the environment from the data folder name', () => {
    expect(envNameOf('/x/Conduit/conduit-dev')).toBe('conduit-dev');
    expect(() => envNameOf('/x/Conduit/other')).toThrow();
  });

  it('records the first launch of a build once', () => {
    root = makeTempRoot('builds');
    const logger = new MemoryLogger();
    expect(recordFirstLaunch(root, '0.18.0', 1000, logger)).toBe(1000);
    expect(recordFirstLaunch(root, '0.18.0', 2000, logger)).toBe(1000);
    expect(recordFirstLaunch(root, '0.18.1', 3000, logger)).toBe(3000);
    expect(JSON.parse(fs.readFileSync(path.join(root, BUILDS_FILE), 'utf8'))).toEqual({ '0.18.1': 3000, '0.18.0': 1000 });
  });
});
