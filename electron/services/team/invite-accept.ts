/**
 * POST of the website's invite accept route with the signed-in user's bearer token
 * (docs/PLAN_ENFORCEMENT.md 2.8). The route answers `{ error }` on failure; its text is written
 * for people (seat or plan problems) and is shown as is.
 */

export const INVITE_ACCEPT_TIMEOUT_MS = 15_000;
export const INVITE_ACCEPT_FALLBACK_MESSAGE = 'Could not join the team.';
const MAX_ERROR_LENGTH = 300;

async function errorText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    if (typeof error === 'string' && error.trim() !== '' && error.length <= MAX_ERROR_LENGTH) return error;
  } catch {
    // Not JSON: the fallback text is shown.
  }
  return INVITE_ACCEPT_FALLBACK_MESSAGE;
}

export async function postInviteAccept(fetchImpl: typeof fetch, websiteUrl: string, accessToken: string, token: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(`${websiteUrl}/api/team/invite/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(INVITE_ACCEPT_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn('[team-service] Invite accept request failed:', err instanceof Error ? err.name : 'Error');
    throw new Error(INVITE_ACCEPT_FALLBACK_MESSAGE);
  }
  if (!res.ok) {
    console.warn('[team-service] Invite accept refused', { status: res.status });
    throw new Error(await errorText(res));
  }
}
