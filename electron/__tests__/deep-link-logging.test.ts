// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const ACCESS = 'eyJhbGciOiJIUzI1NiJ9.access-payload-secret.signature';
const REFRESH = 'refresh-token-secret-value';

const client = {
  auth: {
    onAuthStateChange: vi.fn(),
    setSession: vi.fn(async () => ({ data: { session: null }, error: { message: 'bad session' } })),
  },
};

vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('electron', () => ({ app: {}, net: {}, safeStorage: {} }));
vi.mock('../ipc/settings.js', () => ({ readSettings: () => ({}) }));
vi.mock('../services/env-config.js', () => ({
  getEnvConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: 'anon' }),
  getDataDir: () => '/nonexistent',
}));
vi.mock('../services/state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));

const { describeDeepLink } = await import('../services/deep-link-log.js');
const { AuthService } = await import('../services/auth/supabase.js');

function logged(spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' '))).join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('deep-link logging (docs/AUTO_UNLOCK.md 6.0)', () => {
  it('the main-process log line keeps only scheme, host and path', () => {
    const url = `conduit://auth/callback#access_token=${ACCESS}&refresh_token=${REFRESH}`;
    const line = describeDeepLink(url);
    expect(line).toBe('conduit://auth/callback (parameters not logged)');
    expect(line).not.toContain(REFRESH);
    expect(line).not.toContain('access_token');
    expect(describeDeepLink('not a url')).toBe('(unparseable link)');
  });

  it('handleDeepLinkTokens logs no token values', async () => {
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
    await new AuthService().handleDeepLinkTokens(ACCESS, REFRESH);
    const text = logged(spies);
    expect(text).toContain('handleDeepLinkTokens');
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain(ACCESS);
  });
});
