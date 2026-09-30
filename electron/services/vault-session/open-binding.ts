/**
 * The lineage-to-file binding chosen at open (spec 3.1 file_id, 3.2 local.json binding, 5.8,
 * 5.9 moved-or-copied rule): a first open binds the opened path, adopting S's
 * file_id when it has one; a stored binding at the same realpath is kept; a stored binding at
 * another path means the vault was moved (the old path is gone or no longer holds this
 * lineage: rebind, keep the file_id) or copied on this device (the old path still holds this
 * lineage: bind the opened copy with a NEW file_id and raise a same-device-copy prompt).
 */

import { SESSION_LOG_PREFIX } from '../sync/host.js';
import type { FileBinding, LocalJson } from '../sync/types.js';
import type { OpenContext } from './open-deps.js';
import { samePath, type VaultLocation } from './open-location.js';
import { readSharedView, type SharedView } from './open-peek.js';
import { errCode } from './open-staging.js';

export interface SameDeviceCopy {
  /** The ORIGINAL path (still holding this lineage). */
  readonly path: string;
  readonly sha256: string;
}

export interface BindingPlan {
  /** The binding this open runs with. */
  readonly binding: FileBinding;
  /** What openReplica stores; null keeps the stored binding. */
  readonly toStore: FileBinding | null;
  readonly copyOf: SameDeviceCopy | null;
}

export interface BindingInputs {
  readonly lineageId: string;
  readonly s: SharedView;
  readonly local: LocalJson | null;
}

export async function planBinding(ctx: OpenContext, loc: VaultLocation, p: BindingInputs): Promise<BindingPlan> {
  const stored = p.local?.binding ?? null;
  const at = (fileId: string): FileBinding => ({ sharedPath: ctx.sharedPath, realpath: loc.realpath, fileId });
  if (stored === null) {
    const sFileId = p.s.kind === 'synced' ? p.s.file.fileId : null;
    const binding = at(sFileId ?? ctx.host.random.uuid());
    return { binding, toStore: binding, copyOf: null };
  }
  if (samePath(stored.realpath, loc.realpath, ctx.host.paths.platform)) return { binding: stored, toStore: null, copyOf: null };
  const originalSha = await originalStillHolds(ctx, stored, p.lineageId);
  if (originalSha !== null) {
    ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: same-device copy of a bound vault; new file id`, { lineageId: p.lineageId });
    const binding = at(ctx.host.random.uuid());
    return { binding, toStore: binding, copyOf: { path: stored.sharedPath, sha256: originalSha } };
  }
  ctx.host.logger.info(`${SESSION_LOG_PREFIX} open: bound vault moved; rebinding with the same file id`, { lineageId: p.lineageId });
  const binding = at(stored.fileId);
  return { binding, toStore: binding, copyOf: null };
}

/** SHA-256 of the file at the old bound path when it still holds this lineage, else null. */
async function originalStillHolds(ctx: OpenContext, stored: FileBinding, lineageId: string): Promise<string | null> {
  let view: SharedView;
  try {
    view = await readSharedView(ctx, stored.realpath, { lineageId: null });
  } catch (err) {
    ctx.host.logger.warn(`${SESSION_LOG_PREFIX} open: old bound path could not be read; treating the vault as moved`, { code: errCode(err) });
    return null;
  }
  if (view.kind === 'synced') return view.file.state.lineageId === lineageId ? view.snapshot.sha256 : null;
  // A pre-sync file at a bound path is identified by the binding (3.1), not by its salt.
  if (view.kind === 'presync') return view.snapshot.sha256;
  return null;
}
