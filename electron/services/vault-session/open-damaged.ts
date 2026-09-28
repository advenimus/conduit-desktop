/**
 * A damaged working copy at open (spec 3.2 parks a corrupt local.json and rebuilds it; W gets the
 * same treatment on the user's word): reading W's private copy fails with SQLITE_NOTADB,
 * SQLITE_CORRUPT or a corrupt sync state. The open then fails with VAULT_WORKING_COPY_DAMAGED;
 * with `recoverWorkingCopy` and a usable shared file, W and its -wal/-shm move into the
 * lineage's parked/ folder (never deleted) and W is seeded again from S like on a first open.
 */

import path from 'node:path';
import { lineagePaths } from '../sync/paths.js';
import { SESSION_LOG_PREFIX } from '../sync/host.js';
import { SyncCoreError } from '../sync/types.js';
import type { OpenContext } from './open-deps.js';
import { errCode } from './open-staging.js';

const DAMAGE_CODE_PREFIXES = ['SQLITE_NOTADB', 'SQLITE_CORRUPT'] as const;
const W_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;
const PARKED_PREFIX = 'w-';
const PARKED_EXT = '.conduit';

/** SQLite says the file is not a database or is corrupt, or its sync tables do not load. */
export function isWorkingCopyDamage(err: unknown): boolean {
  if (err instanceof SyncCoreError) return err.code === 'CORRUPT_STATE';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DAMAGE_CODE_PREFIXES.some((p) => code.startsWith(p));
}

/** Moves w.conduit and its companions into parked/w-<ts>.conduit*; only after the password was accepted. */
export async function parkDamagedWorkingCopy(ctx: OpenContext, lineageId: string): Promise<string> {
  const { fs, logger, clock } = ctx.host;
  const lp = lineagePaths(ctx.config.machineDir, lineageId);
  await fs.mkdir(lp.parked);
  const target = path.join(lp.parked, `${PARKED_PREFIX}${clock.now()}${PARKED_EXT}`);
  for (const suffix of W_FILE_SUFFIXES) {
    const from = `${lp.working}${suffix}`;
    if ((await fs.stat(from)) === null) continue;
    try {
      await fs.rename(from, `${target}${suffix}`);
    } catch (err) {
      logger.error(`${SESSION_LOG_PREFIX} open: parking the damaged working copy failed`, { code: errCode(err) });
      throw err;
    }
  }
  logger.warn(`${SESSION_LOG_PREFIX} open: the damaged working copy was parked; seeding it again from the shared file`, {
    parked: path.basename(target),
  });
  return target;
}
