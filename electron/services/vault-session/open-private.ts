/**
 * Private vaults and new vaults (spec 3.2, 6.1 "every vault takes the lease", 6.3, 7.3
 * variants). A private vault (inside the data folder, local volume, not a symlink) opens in
 * place through the existing unlock path after the same early check, password check and
 * acquire; it has no W, engine or claims. vault_create / vault_initialize: the path must not
 * exist; a shared vault gets a random lineage, salt and verification, W seeded as a new
 * vault, then engine.publishInitial(); a private one is created in place.
 */

import { deriveEpochKeys } from '../sync/hashing.js';
import { makeVerificationToken } from '../sync/key-epoch.js';
import { lineagePaths } from '../sync/paths.js';
import { NEW_SALT_BYTES } from '../sync/replica.js';
import type { FileBinding } from '../sync/types.js';
import type { AcquireResult } from './session-client.js';
import { Rollback } from './open-async.js';
import type { OpenContext } from './open-deps.js';
import { fileProblemError, VAULT_EXISTS_MESSAGE } from './open-errors.js';
import { acquireLease, earlyInUseCheck, type CopySource } from './open-gate.js';
import type { VaultLocation } from './open-location.js';
import { verifyPrivatePassword } from './open-password.js';
import type { OpenedPersonalVault } from './open-personal-vault.js';
import { readPrivateVaultFile } from './open-staging.js';
import { startSharedSession } from './open-start.js';

async function readPrivateLineage(ctx: OpenContext): Promise<{ readonly lineageId: string; readonly meta: { salt: string | null; verification: string | null } }> {
  const read = await readPrivateVaultFile(ctx.sharedPath, ctx.stagingDir, ctx.host);
  if (read.kind === 'problem') throw fileProblemError(read.problem, ctx.fileName);
  return read;
}

function startPrivateSession(ctx: OpenContext, lineageId: string, acquire: AcquireResult | null): OpenedPersonalVault {
  const runtime = ctx.c.createRuntime({
    host: ctx.host,
    config: ctx.config,
    lineageId,
    shared: false,
    fileName: ctx.fileName,
    client: ctx.client,
    lease: ctx.lease,
    replica: null,
  });
  runtime.start(acquire);
  return { lineageId, shared: false, runtime, replica: null, engine: null, unlock: null, firstCyclePending: false };
}

/** A private file is its own copy source; its key is PBKDF2 of the password with the file's salt. */
function privateCopySource(ctx: OpenContext, salt: string | null): CopySource {
  return { source: { kind: 'shared', path: ctx.sharedPath }, key: salt === null ? null : ctx.kdf(ctx.input.password, salt) };
}

/** Private vault: early check, password (PBKDF2 + verification token), acquire, then the existing in-place unlock. */
export async function openPrivateVault(ctx: OpenContext, loc: VaultLocation): Promise<OpenedPersonalVault> {
  const file = await readPrivateLineage(ctx);
  await earlyInUseCheck(ctx, loc, { lineageId: file.lineageId, shared: false, claimState: null, local: null });
  verifyPrivatePassword(ctx, file.meta);
  const rollback = new Rollback(ctx.host.logger);
  try {
    const acquire = await acquireLease(ctx, loc, file.lineageId, null, rollback, privateCopySource(ctx, file.meta.salt));
    await ctx.host.access.openPrivateInPlace(ctx.sharedPath, ctx.input.password);
    return startPrivateSession(ctx, file.lineageId, acquire);
  } catch (err) {
    await rollback.run();
    throw err;
  }
}

/** vault_create / vault_initialize (the file must not exist yet). */
export async function createPersonalVault(ctx: OpenContext, loc: VaultLocation): Promise<OpenedPersonalVault> {
  if ((await ctx.host.fs.stat(ctx.sharedPath)) !== null) throw new Error(VAULT_EXISTS_MESSAGE);
  return loc.shared ? createShared(ctx, loc) : createPrivate(ctx, loc);
}

async function createPrivate(ctx: OpenContext, loc: VaultLocation): Promise<OpenedPersonalVault> {
  await ctx.host.access.createPrivateInPlace(ctx.sharedPath, ctx.input.password);
  // The lease key of a private vault derives from the salt ConduitVault just generated (3.2 deviation 6).
  const file = await readPrivateLineage(ctx);
  const rollback = new Rollback(ctx.host.logger);
  try {
    const acquire = await acquireLease(ctx, loc, file.lineageId, null, rollback, privateCopySource(ctx, file.meta.salt));
    return startPrivateSession(ctx, file.lineageId, acquire);
  } catch (err) {
    await rollback.run();
    throw err;
  }
}

async function createShared(ctx: OpenContext, loc: VaultLocation): Promise<OpenedPersonalVault> {
  const { random } = ctx.host;
  const lineageId = random.uuid();
  const salt = random.bytes(NEW_SALT_BYTES).toString('base64');
  const key = ctx.kdf(ctx.input.password, salt);
  const verification = makeVerificationToken(deriveEpochKeys(key, lineageId), (n) => random.bytes(n));
  const binding: FileBinding = { sharedPath: ctx.sharedPath, realpath: loc.realpath, fileId: random.uuid() };
  const rollback = new Rollback(ctx.host.logger);
  try {
    const acquire = await acquireLease(ctx, loc, lineageId, binding.fileId, rollback, { source: { kind: 'shared', path: ctx.sharedPath }, key });
    const lineageDir = lineagePaths(ctx.config.machineDir, lineageId).dir;
    rollback.push('remove new lineage folder', () => ctx.host.fs.rm(lineageDir, { recursive: true, force: true }));
    const opened = await ctx.c.openReplica(
      {
        syncRoot: ctx.config.syncRoot,
        machineDir: ctx.config.machineDir,
        deviceUuid: ctx.config.deviceUuid,
        lineageId,
        key,
        seed: { kind: 'new-vault', salt, verification, vaultId: random.uuid() },
        binding,
      },
      ctx.replicaDeps,
    );
    rollback.push('close replica', () => opened.replica.close());
    const st = { replica: opened.replica, notices: opened.notices, acquire, copyOf: null, unlock: null, create: true, adoptLegacyChange: false };
    return await startSharedSession(ctx, loc, st, rollback);
  } catch (err) {
    await rollback.run();
    throw err;
  }
}
