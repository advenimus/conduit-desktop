// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = vi.hoisted(() => ({ current: '' }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp/conduit-rdp-defaults-test', relaunch: vi.fn(), quit: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
}));
vi.mock('../../services/state.js', () => ({ AppState: { getInstance: vi.fn() } }));
vi.mock('../../services/local-network.js', () => ({ getLocalNetworkStatus: vi.fn() }));
vi.mock('../../services/env-config.js', () => ({ getDataDir: () => dataDir.current }));

async function readWith(file: Record<string, unknown>) {
  fs.writeFileSync(path.join(dataDir.current, 'settings.json'), JSON.stringify(file));
  const { readSettings } = await import('../settings.js');
  return readSettings();
}

describe('readSettings session_defaults_rdp', () => {
  beforeEach(() => {
    dataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-rdp-defaults-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir.current, { recursive: true, force: true });
  });

  it('fills defaults missing from an older stored value', async () => {
    const s = await readWith({ session_defaults_rdp: { resolution: '1280x720', colorDepth: 16 } });
    expect(s.session_defaults_rdp).toEqual({
      resolution: '1280x720',
      colorDepth: 16,
      sound: 'local',
      quality: 'good',
      clipboard: true,
      enableNla: true,
      enableHighDpi: false,
      displayScale: 1.0,
    });
  });

  it('drops the old device gateway keys', async () => {
    const s = await readWith({
      session_defaults_rdp: { gatewayEnabled: true, gatewayHostname: 'gw.corp.example', gatewayPort: 8443, gatewayTransport: 'http', gatewayBypassLocal: true, quality: 'best' },
    });
    expect(s.session_defaults_rdp).toMatchObject({ quality: 'best', resolution: 'match_window' });
    expect(Object.keys(s.session_defaults_rdp).filter((k) => k.startsWith('gateway'))).toEqual([]);
  });

  it('has no gateway keys when the value is missing', async () => {
    const s = await readWith({ theme: 'dark' });
    expect(Object.keys(s.session_defaults_rdp).filter((k) => k.startsWith('gateway'))).toEqual([]);
  });
});
