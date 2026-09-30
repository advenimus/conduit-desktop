/**
 * The key that scopes connection history to one vault (docs/DASHBOARD.md 7.1). Computed in the
 * main process only; the renderer never sends it.
 */

import crypto from 'node:crypto';
import path from 'node:path';

export interface VaultKeyInput {
  /** Set while a team vault is the active vault. */
  readonly teamVaultId: string | null;
  /** vault_meta.vault_id of a personal vault, read without creating it. */
  readonly vaultId: string | null;
  /** The personal vault's shared file path. */
  readonly vaultPath: string;
}

const PATH_HASH_CHARS = 32;

export function historyVaultKey(input: VaultKeyInput): string {
  if (input.teamVaultId) return `team:${input.teamVaultId}`;
  if (input.vaultId) return `vault:${input.vaultId}`;
  const digest = crypto.createHash('sha256').update(path.resolve(input.vaultPath)).digest('hex');
  return `path:${digest.slice(0, PATH_HASH_CHARS)}`;
}
