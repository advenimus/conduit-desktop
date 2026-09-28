/**
 * The unlock path when "Multi-device sync" is off (spec 5.11, 5.12 "engine off" row): every
 * personal vault opens in place like a private one, after the same early in-use check,
 * password check and lease (no working copy, engine or owner claims). Other devices absorb its
 * edits as a legacy writer.
 */

import { createPersonalVault, openPrivateVault } from '../vault-session/open-private.js';
import { makeOpenContext } from '../vault-session/open-deps.js';
import { realpathNearest } from '../vault-session/open-location.js';
import type { OpenDeps, OpenedPersonalVault, OpenPersonalVaultInput } from '../vault-session/open-personal-vault.js';
import { removeStagedCopy } from '../vault-session/open-staging.js';

/** "Multi-device sync" off: every vault opens in place like a private one (lease only, no W or engine). */
export async function openInPlace(input: OpenPersonalVaultInput, deps: OpenDeps): Promise<OpenedPersonalVault> {
  const ctx = makeOpenContext(input, deps);
  const loc = { realpath: await realpathNearest(input.path, deps.host.fs), shared: false };
  await deps.host.fs.mkdir(ctx.stagingDir);
  try {
    return input.create ? await createPersonalVault(ctx, loc) : await openPrivateVault(ctx, loc);
  } finally {
    for (const p of ctx.staged.list()) await removeStagedCopy(p, ctx.host);
  }
}
