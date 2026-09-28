// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { OPEN_ELSEWHERE_MESSAGE, hasConflict, lockedResponse, vaultFailure } from '../vault-guard.js';

function state(opts: { team?: boolean; reason?: string | null; conflict?: (id: string) => boolean } = {}) {
  const personal = {};
  const team = {};
  return {
    vault: personal,
    personalLockReason: opts.reason ?? null,
    getActiveVault: () => (opts.team ? team : personal),
    appSync: { hasConflictForEntry: opts.conflict ?? (() => false) },
  };
}

describe('MCP vault guard', () => {
  it('says the vault is open elsewhere after a displacement', () => {
    expect(lockedResponse(state({ reason: 'open_elsewhere' }), 'Vault is locked').payload).toEqual({
      code: 'VAULT_LOCKED',
      message: OPEN_ELSEWHERE_MESSAGE,
      reason: 'open_elsewhere',
    });
  });

  it('keeps the plain locked error otherwise, and for team vaults', () => {
    expect(lockedResponse(state(), 'Vault is locked').payload).toEqual({ code: 'VAULT_LOCKED', message: 'Vault is locked' });
    expect(lockedResponse(state({ team: true, reason: 'open_elsewhere' }), 'Vault is locked').payload).toEqual({
      code: 'VAULT_LOCKED',
      message: 'Vault is locked',
    });
  });

  it('maps a vault call that raced the displacement to the locked error', () => {
    const blocked = Object.assign(new Error('Vault is locked'), { reason: 'open_elsewhere' });
    expect(vaultFailure('ENTRY_ERROR', blocked).payload).toMatchObject({ code: 'VAULT_LOCKED', reason: 'open_elsewhere' });
    expect(vaultFailure('ENTRY_ERROR', new Error('Entry not found')).payload).toEqual({ code: 'ENTRY_ERROR', message: 'Error: Entry not found' });
  });

  it('reports has_conflict for the personal vault only and never throws', () => {
    const conflict = vi.fn((id: string) => id === 'e1');
    expect(hasConflict(state({ conflict }), 'e1')).toBe(true);
    expect(hasConflict(state({ conflict }), 'e2')).toBe(false);
    expect(hasConflict(state({ conflict, team: true }), 'e1')).toBe(false);
    const broken = () => {
      throw new Error('engine stopped');
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(hasConflict(state({ conflict: broken }), 'e1')).toBe(false);
  });
});
