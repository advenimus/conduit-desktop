// @vitest-environment node
// Team invite accept through the website route (docs/PLAN_ENFORCEMENT.md 2.8, 4.9; test D12).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env-config.js', () => ({ getEnvConfig: () => ({ websiteUrl: 'https://site.test' }) }));

const { TeamService } = await import('../team-service.js');
const { INVITE_ACCEPT_FALLBACK_MESSAGE } = await import('../invite-accept.js');

interface Invitation {
  token: string;
  status: string;
  email: string;
}

function fakeAuth(invitation: Invitation | null, email = 'me@example.com') {
  const inserts: string[] = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    single: vi.fn(async () => (invitation === null ? { data: null, error: { message: 'none' } } : { data: invitation, error: null })),
    insert: vi.fn(async () => {
      inserts.push('insert');
      return { error: null };
    }),
    update: vi.fn(() => {
      inserts.push('update');
      return query;
    }),
  };
  const auth = {
    getAuthState: () => ({ isAuthenticated: true, user: { id: 'u1', email } }),
    getAccessToken: vi.fn(async () => 'access-token'),
    refreshSession: vi.fn(async () => ({})),
    getSupabaseClient: () => ({ from: vi.fn(() => query) }),
  };
  return { auth, query, inserts };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('TeamService.acceptInvitation', () => {
  it('posts the invitation token with the bearer header, writes no rows itself, and refreshes the plan', async () => {
    const { auth, query, inserts } = fakeAuth({ token: 'inv-token', status: 'pending', email: 'Me@Example.com' });
    const fetchImpl = vi.fn(async () => response(200, { success: true }));
    await new TeamService(auth as never, fetchImpl as unknown as typeof fetch).acceptInvitation('inv-1');
    expect(query.select).toHaveBeenCalledWith('token, status, email');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://site.test/api/team/invite/accept');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer access-token', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ token: 'inv-token' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(inserts).toEqual([]);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it('shows the route error text (S18), or the fallback when there is none', async () => {
    const { auth } = fakeAuth({ token: 't', status: 'pending', email: 'me@example.com' });
    const full = vi.fn(async () => response(409, { error: 'All seats on this team are in use. Ask your team admin to add a seat.' }));
    await expect(new TeamService(auth as never, full as unknown as typeof fetch).acceptInvitation('i')).rejects.toThrow(
      'All seats on this team are in use. Ask your team admin to add a seat.',
    );
    const html = vi.fn(async () => new Response('<html>', { status: 502 }));
    await expect(new TeamService(auth as never, html as unknown as typeof fetch).acceptInvitation('i')).rejects.toThrow(INVITE_ACCEPT_FALLBACK_MESSAGE);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(new TeamService(auth as never, offline as unknown as typeof fetch).acceptInvitation('i')).rejects.toThrow('Could not join the team.');
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });

  it('keeps the pending and email checks before any request', async () => {
    const fetchImpl = vi.fn();
    const answered = fakeAuth({ token: 't', status: 'accepted', email: 'me@example.com' });
    await expect(new TeamService(answered.auth as never, fetchImpl as never).acceptInvitation('i')).rejects.toThrow('Invitation already accepted');
    const other = fakeAuth({ token: 't', status: 'pending', email: 'someone@else.com' });
    await expect(new TeamService(other.auth as never, fetchImpl as never).acceptInvitation('i')).rejects.toThrow('different email address');
    const missing = fakeAuth(null);
    await expect(new TeamService(missing.auth as never, fetchImpl as never).acceptInvitation('i')).rejects.toThrow('Invitation not found');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
