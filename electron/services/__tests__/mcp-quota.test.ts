import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const osState = vi.hoisted(() => ({ platform: 'darwin' as NodeJS.Platform, home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const mocked = { ...actual, platform: () => osState.platform, homedir: () => osState.home };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => ({ app: { isPackaged: false } }));

let home: string;

beforeEach(() => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-quota-home-'));
  osState.home = home;
  osState.platform = 'darwin';
  vi.stubEnv('XDG_RUNTIME_DIR', '');
  vi.stubEnv('APPDATA', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

async function desktopStateDir(): Promise<string> {
  const { getMcpStateDir } = await import('../env-config.js');
  return getMcpStateDir();
}

// A variable specifier keeps tsc from pulling mcp/ (a separate package) into electron/'s rootDir.
const MCP_DATA_DIR_MODULE = '../../../mcp/src/data-dir.js';

async function mcpStateDir(): Promise<string> {
  const { getDataDir } = (await import(/* @vite-ignore */ MCP_DATA_DIR_MODULE)) as { getDataDir(): string };
  return getDataDir();
}

describe('getMcpStateDir', () => {
  const cases: Array<{ platform: NodeJS.Platform; env: 'preview' | 'production'; xdg?: string; appData?: string }> = [
    { platform: 'darwin', env: 'preview' },
    { platform: 'darwin', env: 'production' },
    { platform: 'linux', env: 'preview' },
    { platform: 'linux', env: 'production', xdg: '/run/user/1000' },
    { platform: 'win32', env: 'preview', appData: 'C:\\Users\\me\\AppData\\Roaming' },
    { platform: 'win32', env: 'production' },
  ];

  it.each(cases)('matches the MCP process on $platform ($env, xdg=$xdg, appData=$appData)', async ({ platform, env, xdg, appData }) => {
    osState.platform = platform;
    vi.stubEnv('CONDUIT_ENV', env);
    if (xdg) vi.stubEnv('XDG_RUNTIME_DIR', xdg);
    if (appData) vi.stubEnv('APPDATA', appData);

    expect(await desktopStateDir()).toBe(await mcpStateDir());
  });

  it('keeps dev and production counters apart', async () => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    const dev = await desktopStateDir();
    vi.resetModules();
    vi.stubEnv('CONDUIT_ENV', 'production');
    const prod = await desktopStateDir();

    expect(dev).toBe(path.join(home, 'Library', 'Application Support', 'conduit-dev'));
    expect(prod).toBe(path.join(home, 'Library', 'Application Support', 'conduit'));
  });
});

describe('resetMcpQuotaForDevLaunch', () => {
  async function writeLedger(): Promise<string> {
    const { getMcpQuotaFilePath } = await import('../mcp-quota.js');
    const file = getMcpQuotaFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ calls: [Date.now(), Date.now()] }));
    return file;
  }

  it('clears the ledger on a dev (unpackaged) launch', async () => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    const file = await writeLedger();
    const { resetMcpQuotaForDevLaunch } = await import('../mcp-quota.js');

    expect(resetMcpQuotaForDevLaunch(false)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves the ledger alone in packaged builds so the free-tier cap holds', async () => {
    vi.stubEnv('CONDUIT_ENV', 'production');
    const file = await writeLedger();
    const { resetMcpQuotaForDevLaunch } = await import('../mcp-quota.js');

    expect(resetMcpQuotaForDevLaunch(true)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).calls).toHaveLength(2);
  });

  it('does not fail when there is no ledger yet', async () => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    const { resetMcpQuotaForDevLaunch } = await import('../mcp-quota.js');

    expect(() => resetMcpQuotaForDevLaunch(false)).not.toThrow();
  });
});
