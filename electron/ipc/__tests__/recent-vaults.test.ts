// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { clearRecentVaults, removeRecentVault, withMovedRecentVault, withoutRecentVault, type RecentVaultDeps } from '../recent-vaults.js';

vi.mock('../../services/vault/biometric.js', () => {
  const removed: string[] = [];
  return {
    removed,
    getBiometricService: () => ({ removePassword: (key: string) => removed.push(key), isEnabledForVault: () => false }),
    moveKey: () => false,
    vaultPathToKey: (p: string) => `path:${p}`,
    vaultLineageToKey: (id: string) => `lineage:${id}`,
  };
});

interface Fields {
  recent_vaults: string[];
  last_vault_path: string | null;
  theme: string;
}

const A = '/v/a.conduit';
const B = '/v/b.conduit';

function harness(initial: Fields, removeBiometric: (p: string) => Promise<void> = async () => undefined) {
  let stored = initial;
  const removeAll = vi.fn();
  const deps: RecentVaultDeps<Fields> = {
    read: () => stored,
    write: (s) => {
      stored = s;
    },
    removeBiometric: vi.fn(removeBiometric),
    removeAllBiometric: removeAll,
  };
  return { deps, stored: () => stored, removeAll };
}

describe('recent vault removal', () => {
  it('drops the vault, moves last_vault_path on and keeps other settings (no mutation)', () => {
    const before: Fields = { recent_vaults: [A, B], last_vault_path: A, theme: 'dark' };
    const after = withoutRecentVault(before, A);
    expect(after).toEqual({ recent_vaults: [B], last_vault_path: B, theme: 'dark' });
    expect(before.recent_vaults).toEqual([A, B]);
    expect(withoutRecentVault({ ...before, last_vault_path: B }, A).last_vault_path).toBe(B);
  });

  it('removes the biometric entry of that vault (lineage and path keys)', async () => {
    const h = harness({ recent_vaults: [A, B], last_vault_path: B, theme: 'x' });
    expect(await removeRecentVault(h.deps, A)).toEqual([B]);
    expect(h.deps.removeBiometric).toHaveBeenCalledWith(A);
    expect(h.stored().recent_vaults).toEqual([B]);
  });

  it('a failed biometric cleanup never fails the removal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = harness({ recent_vaults: [A], last_vault_path: A, theme: 'x' }, () => Promise.reject(new Error('keychain')));
    expect(await removeRecentVault(h.deps, A)).toEqual([]);
    expect(h.stored().last_vault_path).toBeNull();
    warn.mockRestore();
  });

  it('clearing the list removes every stored biometric entry', () => {
    const h = harness({ recent_vaults: [A, B], last_vault_path: A, theme: 'x' });
    expect(clearRecentVaults(h.deps)).toEqual([]);
    expect(h.stored()).toEqual({ recent_vaults: [], last_vault_path: null, theme: 'x' });
    expect(h.removeAll).toHaveBeenCalledTimes(1);
  });
});

describe('removeBiometricForPath', () => {
  it('removes the lineage key and the legacy path key', async () => {
    const { removeBiometricForPath } = await import('../biometric-lineage.js');
    const bio = (await import('../../services/vault/biometric.js')) as unknown as { removed: string[] };
    const state = { appSync: { lineageForPath: async () => 'L1', currentLineageId: () => null }, currentVaultPath: A };
    await removeBiometricForPath(state as never, A);
    expect(bio.removed).toEqual(['lineage:L1', `path:${A}`]);
  });
});

describe('a vault file that moved (spec 5.9 rebind, Locate, rename)', () => {
  const MOVED = '/v/renamed.conduit';

  it('keeps its place in the recent list and stays the last vault (no mutation)', () => {
    const before: Fields = { recent_vaults: [A, B], last_vault_path: A, theme: 'dark' };
    expect(withMovedRecentVault(before, A, MOVED)).toEqual({ recent_vaults: [MOVED, B], last_vault_path: MOVED, theme: 'dark' });
    expect(before).toEqual({ recent_vaults: [A, B], last_vault_path: A, theme: 'dark' });
  });

  it('never lists the new path twice and leaves another last vault alone', () => {
    const before: Fields = { recent_vaults: [B, A, MOVED], last_vault_path: B, theme: 'x' };
    expect(withMovedRecentVault(before, A, MOVED)).toEqual({ recent_vaults: [B, MOVED], last_vault_path: B, theme: 'x' });
  });

  it('changes nothing when the old path was not listed', () => {
    const before: Fields = { recent_vaults: [B], last_vault_path: null, theme: 'x' };
    expect(withMovedRecentVault(before, A, MOVED)).toEqual(before);
  });
});
