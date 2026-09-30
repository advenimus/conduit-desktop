// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isEntryTierLocked, tierLockedEntryIds, type TierEntry, type TierLockState } from '../tier-lock.js';

const entries: TierEntry[] = [
  { id: 'new-ssh', entry_type: 'ssh', created_at: '2026-03-01T00:00:00Z' },
  { id: 'cred', entry_type: 'credential', created_at: '2026-01-01T00:00:00Z' },
  { id: 'old-rdp', entry_type: 'rdp', created_at: '2026-01-02T00:00:00Z' },
  { id: 'doc', entry_type: 'document', created_at: '2026-04-01T00:00:00Z' },
  { id: 'mid-web', entry_type: 'web', created_at: '2026-02-01T00:00:00Z' },
];

function state(opts: { team?: boolean; authMode?: string; limit?: unknown; profile?: boolean } = {}): TierLockState {
  return {
    teamVaultManager: { getActiveVaultId: () => (opts.team ? 'team-1' : null) },
    authService: {
      getAuthState: () => ({
        authMode: opts.authMode ?? 'authenticated',
        profile: opts.profile === false ? null : { tier: { features: { max_connections: opts.limit } } },
      }),
    },
    getActiveVault: () => ({ listEntries: () => entries }),
  };
}

describe('tierLockedEntryIds', () => {
  it('keeps the oldest connection entries open and never locks credentials or documents', () => {
    expect([...tierLockedEntryIds(entries, 2)]).toEqual(['new-ssh']);
    expect([...tierLockedEntryIds(entries, 0)].sort()).toEqual(['mid-web', 'new-ssh', 'old-rdp']);
    expect(tierLockedEntryIds(entries, -1).size).toBe(0);
  });
});

describe('isEntryTierLocked', () => {
  it('locks entries past the plan limit', () => {
    expect(isEntryTierLocked(state({ limit: 2 }), 'new-ssh')).toBe(true);
    expect(isEntryTierLocked(state({ limit: 2 }), 'old-rdp')).toBe(false);
    expect(isEntryTierLocked(state({ limit: 2 }), 'cred')).toBe(false);
  });

  it('fails open for team vaults, local mode, no profile, unlimited and a missing limit', () => {
    expect(isEntryTierLocked(state({ limit: 1, team: true }), 'new-ssh')).toBe(false);
    expect(isEntryTierLocked(state({ limit: 1, authMode: 'local' }), 'new-ssh')).toBe(false);
    expect(isEntryTierLocked(state({ limit: 1, profile: false }), 'new-ssh')).toBe(false);
    expect(isEntryTierLocked(state({ limit: -1 }), 'new-ssh')).toBe(false);
    expect(isEntryTierLocked(state({}), 'new-ssh')).toBe(false);
  });
});
