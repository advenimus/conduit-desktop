// @vitest-environment node
import crypto from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { historyVaultKey } from '../vault-key.js';

describe('historyVaultKey', () => {
  it('uses the team vault id for a team vault', () => {
    expect(historyVaultKey({ teamVaultId: 'tv-1', vaultId: 'v-1', vaultPath: '/x.conduit' })).toBe('team:tv-1');
  });

  it('uses vault_meta.vault_id for a personal vault that has one', () => {
    expect(historyVaultKey({ teamVaultId: null, vaultId: 'v-1', vaultPath: '/x.conduit' })).toBe('vault:v-1');
  });

  it('falls back to the first 32 hex chars of sha256 of the resolved path', () => {
    const rel = path.join('some', '..', 'vaults', 'home.conduit');
    const expected = crypto.createHash('sha256').update(path.resolve(rel)).digest('hex').slice(0, 32);
    const key = historyVaultKey({ teamVaultId: null, vaultId: null, vaultPath: rel });
    expect(key).toBe(`path:${expected}`);
    expect(key).toMatch(/^path:[0-9a-f]{32}$/);
    expect(key).not.toContain('home');
  });
});
