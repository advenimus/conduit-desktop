// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { envConfig, nodeAppwrite } from './appwrite-mocks.js';

const tierRow = (name: string, cloud: boolean) => ({ name, display_name: name, features: { cloud_sync_enabled: cloud } });
const server = { profiles: new Map<string, Record<string, unknown>>(), requests: [] as Record<string, unknown>[] };

vi.mock('node-appwrite', () => nodeAppwrite());
vi.mock('../../backend/transport.js', () => ({
  functionTransport: () => async (body: string) => {
    const req = JSON.parse(body) as { filters: { column: string; value: string }[] };
    server.requests.push(req);
    const id = req.filters.find((f) => f.column === 'id')?.value ?? '';
    const row = server.profiles.get(id);
    return row
      ? { status: 200, body: JSON.stringify({ data: row, error: null }) }
      : { status: 500, body: JSON.stringify({ data: null, error: { code: 'NETWORK', message: 'fetch failed', details: null, hint: null } }) };
  },
  directFiles: () => ({}),
}));
vi.mock('electron', () => ({ app: {}, net: {}, safeStorage: {} }));
vi.mock('../../../ipc/settings.js', () => ({ readSettings: () => ({}) }));
vi.mock('../../env-config.js', () => envConfig());
vi.mock('../../state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));

const { AuthService } = await import('../auth-service.js');

const profile = (id: string, tier: ReturnType<typeof tierRow>) => ({ id, display_name: null, tier_id: tier.name, is_team_member: false, created_at: 'c', updated_at: 'u', tier });

/** Signed in as u1 with the profile read at sign-in (Pro). */
function signedIn() {
  const svc = new AuthService();
  (svc as unknown as { useSession: (s: string) => void }).useSession('secret');
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
  server.profiles.clear();
  server.requests = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('AuthService.reloadProfile', () => {
  it('stores a plan change made since sign-in, without notifying listeners', async () => {
    const svc = signedIn();
    const listener = vi.fn();
    svc.onStateChange(listener);
    server.profiles.set('u1', profile('u1', tierRow('free', false)));
    const read = await svc.reloadProfile();
    expect(read?.tier?.name).toBe('free');
    expect(svc.getAuthState().profile?.tier?.features).toEqual({ cloud_sync_enabled: false });
    expect(svc.getAuthState().isAuthenticated).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    expect(server.requests[0]).toMatchObject({ kind: 'query', op: 'select', table: 'user_profiles', single: 'one' });
  });

  it('keeps the profile it has when the read fails', async () => {
    const svc = signedIn();
    expect(await svc.reloadProfile()).toBeNull();
    expect(svc.getAuthState().profile?.tier?.name).toBe('pro');
  });

  it("never stores another user's profile", async () => {
    const svc = signedIn();
    server.profiles.set('u1', profile('u2', tierRow('free', false)));
    await svc.reloadProfile();
    expect(svc.getAuthState().profile?.tier?.name).toBe('pro');
  });

  it('reads nothing while signed out', async () => {
    const svc = new AuthService();
    server.profiles.set('u1', profile('u1', tierRow('free', false)));
    expect(await svc.reloadProfile()).toBeNull();
    expect(svc.getAuthState().profile).toBeNull();
    expect(server.requests).toEqual([]);
  });
});
