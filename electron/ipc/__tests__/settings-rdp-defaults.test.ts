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

  it('adds the gateway defaults to an older stored value', async () => {
    const s = await readWith({ session_defaults_rdp: { resolution: '1280x720', colorDepth: 16 } });
    expect(s.session_defaults_rdp).toMatchObject({
      resolution: '1280x720',
      colorDepth: 16,
      clipboard: true,
      gatewayEnabled: false,
      gatewayHostname: '',
      gatewayPort: 443,
      gatewayTransport: 'auto',
      gatewayBypassLocal: false,
    });
  });

  it('keeps stored gateway values', async () => {
    const s = await readWith({
      session_defaults_rdp: { gatewayEnabled: true, gatewayHostname: 'gw.corp.example', gatewayPort: 8443 },
    });
    expect(s.session_defaults_rdp).toMatchObject({
      gatewayEnabled: true,
      gatewayHostname: 'gw.corp.example',
      gatewayPort: 8443,
      resolution: 'match_window',
    });
  });

  it('has the gateway defaults when the key is missing', async () => {
    const s = await readWith({ theme: 'dark' });
    expect(s.session_defaults_rdp).toMatchObject({ gatewayEnabled: false, gatewayPort: 443 });
  });
});
