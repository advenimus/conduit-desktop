/**
 * Biometric storage keys (spec 5.9): the stored password is keyed by the vault's lineage, so
 * renames, moves and a vault opened from another path keep working. The legacy key is a hash
 * of the vault path; its file moves to the lineage key at the first unlock.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BIOMETRIC_FILE_SUFFIX = '.bio.enc';
const LINEAGE_KEY_PREFIX = 'lineage:';
const LOG_PREFIX = '[vault]';

/** Filesystem-safe key of a vault lineage. */
export function vaultLineageToKey(lineageId: string): string {
  return crypto.createHash('sha256').update(LINEAGE_KEY_PREFIX + lineageId).digest('hex');
}

export function biometricFilePath(dir: string, key: string): string {
  return path.join(dir, `${key}${BIOMETRIC_FILE_SUFFIX}`);
}

/**
 * Renames `{from}.bio.enc` to `{to}.bio.enc` when the source exists and the target does not.
 * Returns true when it moved a file. Never throws.
 */
export function moveKeyFile(dir: string, fromKey: string, toKey: string): boolean {
  if (fromKey === toKey) return false;
  const from = biometricFilePath(dir, fromKey);
  const to = biometricFilePath(dir, toKey);
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    fs.renameSync(from, to);
    console.log(`${LOG_PREFIX} biometric entry moved to its lineage key`);
    return true;
  } catch (err) {
    console.warn(`${LOG_PREFIX} biometric entry could not be moved`, { name: err instanceof Error ? err.name : 'Error' });
    return false;
  }
}

/** Removes every stored entry in `dir`, lineage-keyed and path-keyed alike. Never throws. */
export function removeAllKeyFiles(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(BIOMETRIC_FILE_SUFFIX)) fs.rmSync(path.join(dir, file), { force: true });
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} biometric entries could not all be removed`, { name: err instanceof Error ? err.name : 'Error' });
  }
}
