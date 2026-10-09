// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSecretScrubber, guardSecrets } from '../secret-guard.js';
import { credentialGetResponse } from '../credential-reveal.js';
import { ApprovalManager } from '../../services/reveal-approvals.js';
import { successResponse } from '../ipc-response.js';

const SECRET = '11111111-2222-4333-8444-555555555555';
const OWNER = '99999999-2222-4333-8444-555555555555';

function fakeVault(unlocked = true) {
  const rows: Record<string, { name: string; entry_type: string; password: string | null; username: string | null; config: Record<string, unknown> }> = {
    [SECRET]: { name: 'Local admin', entry_type: 'credential', password: 'hunter2-long', username: null, config: { embedded: { owner_id: OWNER, label: 'Local admin' } } },
    [OWNER]: { name: 'web-01', entry_type: 'ssh', password: null, username: 'root', config: {} },
  };
  return {
    isUnlocked: () => unlocked,
    listEntries: () => Object.entries(rows).map(([id, r]) => ({ id, name: r.name, entry_type: r.entry_type, config: r.config, updated_at: '2026-01-01T00:00:00.000Z' })),
    getEntry: (id: string) => ({ password: rows[id].password, private_key: null }),
    getEntryMeta: (id: string) => {
      if (!rows[id]) throw new Error('not found');
      return { name: rows[id].name, config: rows[id].config };
    },
    getCredential: (id: string) => {
      const r = rows[id];
      if (!r) throw new Error('not found');
      return {
        id, name: r.name, username: r.username, password: r.password, domain: null, private_key: null, totp_secret: null, tags: [],
        credential_type: null, public_key: null, fingerprint: null, totp_issuer: null, totp_label: null, totp_algorithm: null,
        totp_digits: null, totp_period: null, created_at: 'x', updated_at: 'x',
      };
    },
  };
}

let vault = fakeVault();
const state = { getActiveVault: () => vault, vault: {}, approvalManager: new ApprovalManager() };

beforeEach(() => {
  vault = fakeVault();
  clearSecretScrubber();
});

describe('guardSecrets', () => {
  it('types the real value but hands back only the ref', async () => {
    const next = vi.fn(async (req: { payload?: Record<string, unknown> }) =>
      successResponse({ output: `ran: ${req.payload?.command as string}`, exit_code: 0 }));
    const res = await guardSecrets(
      { type: 'TerminalExecute', payload: { session_id: 's', command: `echo {{secret:${SECRET}|Local admin}}` } },
      state,
      next,
    );
    expect(next.mock.calls[0][0].payload?.command).toBe('echo hunter2-long');
    expect(res.payload).toEqual({ output: `ran: echo {{secret:${SECRET}|Local admin}}`, exit_code: 0 });
  });

  it('substitutes refs inside terminal keystroke bytes', async () => {
    const next = vi.fn(async (_req: { payload?: Record<string, unknown> }) => successResponse({ screen: '' }));
    const data = Array.from(new TextEncoder().encode(`{{secret:${SECRET}}}\r`));
    await guardSecrets({ type: 'TerminalSendKeys', payload: { session_id: 's', data } }, state, next);
    const sent = new TextDecoder().decode(Uint8Array.from(next.mock.calls[0][0].payload?.data as number[]));
    expect(sent).toBe('hunter2-long\r');
  });

  it('refuses refs in page scripts and unknown refs', async () => {
    const next = vi.fn();
    const js = await guardSecrets({ type: 'WebSessionExecuteJs', payload: { session_id: 's', code: `"{{secret:${SECRET}}}"` } }, state, next);
    expect(js).toMatchObject({ type: 'Error', payload: { code: 'SECRET_REF_ERROR' } });
    const unknown = await guardSecrets({ type: 'RdpType', payload: { connection_id: 'c', text: '{{secret:00000000-2222-4333-8444-555555555555}}' } }, state, next);
    expect(unknown).toMatchObject({ type: 'Error', payload: { code: 'SECRET_REF_ERROR' } });
    expect(next).not.toHaveBeenCalled();
  });

  it('fails clearly when the vault is locked', async () => {
    vault = fakeVault(false);
    const res = await guardSecrets({ type: 'VncType', payload: { connection_id: 'c', text: `{{secret:${SECRET}}}` } }, state, vi.fn());
    expect(res).toMatchObject({ type: 'Error', payload: { code: 'VAULT_LOCKED' } });
  });

  it('scrubs secrets that show up in read results', async () => {
    const next = vi.fn(async () => successResponse({ content: 'DB_PASSWORD=hunter2-long' }));
    const res = await guardSecrets({ type: 'TerminalReadScreen', payload: { session_id: 's' } }, state, next);
    expect(res.payload).toEqual({ content: `DB_PASSWORD={{secret:${SECRET}|Local admin}}` });
  });

  it('passes other requests through untouched', async () => {
    const payload = { query: 'hunter2-long' };
    const next = vi.fn(async (_req: { payload?: Record<string, unknown> }) => successResponse({ echoed: 'hunter2-long' }));
    const res = await guardSecrets({ type: 'EntrySearch', payload }, state, next);
    expect(next.mock.calls[0][0].payload).toBe(payload);
    expect(res.payload).toEqual({ echoed: 'hunter2-long' });
  });
});

describe('credentialGetResponse', () => {
  it('returns refs and no values without reveal', async () => {
    const res = await credentialGetResponse({ id: SECRET }, state, null);
    expect(res.payload).toMatchObject({ password: null, revealed: false, password_ref: `{{secret:${SECRET}|Local admin}}` });
  });

  it('needs a purpose and the user\'s Allow to reveal', async () => {
    const approvals = new ApprovalManager();
    const requested = vi.fn();
    approvals.setNotifier({ requested, resolved: vi.fn() });
    const s = { ...state, approvalManager: approvals };

    expect(await credentialGetResponse({ id: SECRET, reveal: true }, s, null)).toMatchObject({ payload: { code: 'INVALID_ARGUMENT' } });

    const pending = credentialGetResponse({ id: SECRET, reveal: true, purpose: 'show the user' }, s, { id: 'a', pid: 1, client: 'claude-code' });
    await vi.waitFor(() => expect(requested).toHaveBeenCalled());
    const info = requested.mock.calls[0][0];
    expect(info).toMatchObject({ agent_name: 'Claude Code', kind: 'secret', target_name: 'Local admin', owner_name: 'web-01', purpose: 'show the user' });
    approvals.resolve(info.request_id, true);
    expect((await pending).payload).toMatchObject({ password: 'hunter2-long', revealed: true });
  });

  it('denies on Deny, on timeout, and when no window can ask', async () => {
    const approvals = new ApprovalManager();
    const s = { ...state, approvalManager: approvals };
    expect(await credentialGetResponse({ id: SECRET, reveal: true, purpose: 'x' }, s, null)).toMatchObject({ payload: { code: 'APPROVAL_DENIED' } });

    vi.useFakeTimers();
    try {
      approvals.setNotifier({ requested: vi.fn(), resolved: vi.fn() });
      const pending = credentialGetResponse({ id: SECRET, reveal: true, purpose: 'x' }, s, null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toMatchObject({ payload: { code: 'APPROVAL_DENIED' } });
    } finally {
      vi.useRealTimers();
    }
  });
});
