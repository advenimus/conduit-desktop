// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { onAuthStateChange: vi.fn() } }) }));
vi.mock('electron', () => ({ app: {}, net: {}, safeStorage: {} }));
vi.mock('../../../ipc/settings.js', () => ({ readSettings: () => ({}) }));
vi.mock('../../env-config.js', () => ({
  getEnvConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: 'anon' }),
  getDataDir: () => '/nonexistent',
}));
vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));

const { AuthService } = await import('../supabase.js');

describe('AuthService initialized flag (docs/AUTO_UNLOCK.md 4.1)', () => {
  it('is false until the first initialize finishes, then runs listeners once', async () => {
    const svc = new AuthService();
    (svc as unknown as { _doInitialize: () => Promise<unknown> })._doInitialize = async () => ({ user: null });
    const seen = vi.fn();
    svc.onInitialized(seen);
    expect(svc.hasInitialized()).toBe(false);
    await svc.initialize();
    await svc.initialize();
    expect(svc.hasInitialized()).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    svc.onInitialized(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('a failed initialize still counts as finished', async () => {
    const svc = new AuthService();
    (svc as unknown as { _doInitialize: () => Promise<unknown> })._doInitialize = async () => {
      throw new Error('boom');
    };
    await expect(svc.initialize()).rejects.toThrow('boom');
    expect(svc.hasInitialized()).toBe(true);
  });
});
