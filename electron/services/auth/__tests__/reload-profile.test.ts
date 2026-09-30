// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tierRow = (name: string, cloud: boolean) => ({ name, display_name: name, features: { cloud_sync_enabled: cloud } });
const server = { profile: null as Record<string, unknown> | null, userId: 'u1' };

const client = {
  auth: {
    onAuthStateChange: vi.fn(),
    getUser: vi.fn(async () => ({ data: { user: { id: server.userId } } })),
  },
  from: vi.fn(() => ({
    select: () => ({
      eq: () => ({
        single: async () => (server.profile ? { data: server.profile, error: null } : { data: null, error: { message: 'fetch failed' } }),
      }),
    }),
  })),
};

vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('electron', () => ({ app: {}, net: {}, safeStorage: {} }));
vi.mock('../../../ipc/settings.js', () => ({ readSettings: () => ({}) }));
vi.mock('../../env-config.js', () => ({
  getEnvConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: 'anon' }),
  getDataDir: () => '/nonexistent',
}));
vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));

const { AuthService } = await import('../supabase.js');

const profile = (id: string, tier: ReturnType<typeof tierRow>) => ({ id, display_name: null, tier_id: tier.name, is_team_member: false, created_at: 'c', updated_at: 'u', tier });

/** Signed in as u1 with the profile read at sign-in (Pro). */
function signedIn() {
  const svc = new AuthService();
  (svc as unknown as { currentState: unknown }).currentState = {
    user: { id: 'u1', email: 'u1@example.test', email_confirmed_at: 'x', created_at: 'c' },
    profile: profile('u1', tierRow('pro', true)),
    isAuthenticated: true,
    emailConfirmed: true,
    authMode: 'authenticated',
  };
  return svc;
}

beforeEach(() => {
  server.userId = 'u1';
  server.profile = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('AuthService.reloadProfile', () => {
  it('stores a plan change made since sign-in, without notifying listeners', async () => {
    const svc = signedIn();
    const listener = vi.fn();
    svc.onStateChange(listener);
    server.profile = profile('u1', tierRow('free', false));
    const read = await svc.reloadProfile();
    expect(read?.tier?.name).toBe('free');
    expect(svc.getAuthState().profile?.tier?.features).toEqual({ cloud_sync_enabled: false });
    expect(svc.getAuthState().isAuthenticated).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the profile it has when the read fails', async () => {
    const svc = signedIn();
    expect(await svc.reloadProfile()).toBeNull();
    expect(svc.getAuthState().profile?.tier?.name).toBe('pro');
  });

  it('never stores another user\'s profile', async () => {
    const svc = signedIn();
    server.userId = 'u2';
    server.profile = profile('u2', tierRow('free', false));
    await svc.reloadProfile();
    expect(svc.getAuthState().profile?.tier?.name).toBe('pro');
  });

  it('reads nothing while signed out', async () => {
    const svc = new AuthService();
    server.profile = profile('u1', tierRow('free', false));
    expect(await svc.reloadProfile()).toBeNull();
    expect(svc.getAuthState().profile).toBeNull();
  });
});
