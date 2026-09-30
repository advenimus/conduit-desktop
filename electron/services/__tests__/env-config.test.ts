// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ isPackaged: false }));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: () => '/tmp/conduit-env-config-test',
  },
}));

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../env-config.js');
  return mod.getEnvConfig();
}

beforeEach(() => {
  electronState.isPackaged = false;
  vi.unstubAllEnvs();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('getEnvConfig (spec 6.8)', () => {
  it('dev builds default to preview and honor CONDUIT_ENV', async () => {
    vi.stubEnv('CONDUIT_ENV', '');
    expect((await loadConfig()).environment).toBe('preview');
    vi.stubEnv('CONDUIT_ENV', 'production');
    expect((await loadConfig()).environment).toBe('production');
  });

  it('packaged builds ignore CONDUIT_ENV and always use production', async () => {
    electronState.isPackaged = true;
    vi.stubEnv('CONDUIT_ENV', 'preview');
    const config = await loadConfig();
    expect(config.environment).toBe('production');
    expect(config.supabaseUrl).not.toContain('127.0.0.1');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('ignored in packaged builds'));
  });
});

async function loadDevServerUrl() {
  vi.resetModules();
  const mod = await import('../env-config.js');
  return mod.devServerUrl;
}

describe('devServerUrl', () => {
  it('defaults to the Vite port when no override is set', async () => {
    vi.stubEnv('CONDUIT_DEV_SERVER_URL', '');
    const devServerUrl = await loadDevServerUrl();
    expect(devServerUrl()).toBe('http://localhost:1420');
    expect(devServerUrl('picker.html')).toBe('http://localhost:1420/picker.html');
    expect(devServerUrl('overlay.html')).toBe('http://localhost:1420/overlay.html');
  });

  it('dev builds honor CONDUIT_DEV_SERVER_URL and drop trailing slashes', async () => {
    vi.stubEnv('CONDUIT_DEV_SERVER_URL', 'http://localhost:51234/');
    const devServerUrl = await loadDevServerUrl();
    expect(devServerUrl()).toBe('http://localhost:51234');
    expect(devServerUrl('overlay.html')).toBe('http://localhost:51234/overlay.html');
  });

  it('packaged builds ignore the override', async () => {
    electronState.isPackaged = true;
    vi.stubEnv('CONDUIT_DEV_SERVER_URL', 'http://localhost:51234');
    const devServerUrl = await loadDevServerUrl();
    expect(devServerUrl('picker.html')).toBe('http://localhost:1420/picker.html');
  });

  it.each(['not a url', 'file:///etc/passwd', 'javascript:alert(1)'])('falls back to the default for %s', async (raw) => {
    vi.stubEnv('CONDUIT_DEV_SERVER_URL', raw);
    const devServerUrl = await loadDevServerUrl();
    expect(devServerUrl()).toBe('http://localhost:1420');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CONDUIT_DEV_SERVER_URL'));
  });
});

describe('CONDUIT_DEV_SUPABASE_URL', () => {
  const PREVIEW_SUPABASE = 'http://127.0.0.1:54321';

  beforeEach(() => {
    vi.mocked(console.warn).mockClear();
  });

  it('dev preview builds use the override (a local proxy) and keep the preview anon key', async () => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', 'http://127.0.0.1:61234/');
    const config = await loadConfig();
    expect(config.supabaseUrl).toBe('http://127.0.0.1:61234');
    expect(config.environment).toBe('preview');
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', '');
    expect((await loadConfig()).supabaseAnonKey).toBe(config.supabaseAnonKey);
  });

  it('accepts localhost and keeps only the origin', async () => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', 'http://localhost:61235/some/path');
    expect((await loadConfig()).supabaseUrl).toBe('http://localhost:61235');
  });

  it('is unset by default', async () => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', '');
    expect((await loadConfig()).supabaseUrl).toBe(PREVIEW_SUPABASE);
  });

  it('packaged builds ignore it', async () => {
    electronState.isPackaged = true;
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', 'http://127.0.0.1:61234');
    const config = await loadConfig();
    expect(config.environment).toBe('production');
    expect(config.supabaseUrl).not.toContain('127.0.0.1');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CONDUIT_DEV_SUPABASE_URL is ignored'));
  });

  it('dev builds on production ignore it', async () => {
    vi.stubEnv('CONDUIT_ENV', 'production');
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', 'http://127.0.0.1:61234');
    const config = await loadConfig();
    expect(config.supabaseUrl).not.toContain('127.0.0.1');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CONDUIT_DEV_SUPABASE_URL is ignored'));
  });

  it.each(['not a url', 'file:///etc/passwd', 'https://example.com', 'http://10.0.0.5:54321'])('ignores %s', async (raw) => {
    vi.stubEnv('CONDUIT_ENV', 'preview');
    vi.stubEnv('CONDUIT_DEV_SUPABASE_URL', raw);
    expect((await loadConfig()).supabaseUrl).toBe(PREVIEW_SUPABASE);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('CONDUIT_DEV_SUPABASE_URL'));
  });
});
