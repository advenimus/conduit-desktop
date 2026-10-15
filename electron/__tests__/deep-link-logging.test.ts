// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { account, envConfig, nodeAppwrite } from '../services/auth/__tests__/appwrite-mocks.js';

const SECRET = 'session-secret-value-that-must-not-be-logged';
const USER = 'f9e01f36-cca0-4f2d-95bf-f51675511988';

vi.mock('node-appwrite', () => nodeAppwrite());
vi.mock('electron', () => ({ app: {}, net: {}, safeStorage: {} }));
vi.mock('../ipc/settings.js', () => ({ readSettings: () => ({}) }));
vi.mock('../services/env-config.js', () => envConfig());
vi.mock('../services/state.js', () => ({ AppState: { getInstance: () => ({ getMainWindow: () => null }) } }));

const { describeDeepLink } = await import('../services/deep-link-log.js');
const { AuthService } = await import('../services/auth/auth-service.js');

function logged(spies: ReturnType<typeof vi.spyOn>[]): string {
  return spies.flatMap((s) => s.mock.calls.map((c: unknown[]) => c.map(String).join(' '))).join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('deep-link logging (docs/AUTO_UNLOCK.md 6.0)', () => {
  it('the main-process log line keeps only scheme, host and path', () => {
    const url = `conduit://auth/callback#user_id=${USER}&session=${SECRET}`;
    const line = describeDeepLink(url);
    expect(line).toBe('conduit://auth/callback (parameters not logged)');
    expect(line).not.toContain(SECRET);
    expect(line).not.toContain('session=');
    expect(describeDeepLink('not a url')).toBe('(unparseable link)');
  });

  it('handleDeepLinkSession logs no secret', async () => {
    account.get.mockImplementationOnce(async () => {
      throw new Error('bad session');
    });
    const spies = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})];
    await new AuthService().handleDeepLinkSession(USER, SECRET);
    const text = logged(spies);
    expect(text).toContain('Session handoff received');
    expect(text).not.toContain(SECRET);
  });
});
