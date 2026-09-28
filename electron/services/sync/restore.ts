/**
 * Backup restores for synced vaults (spec 5.10 "Backup restore", 12 row 20): a plain file
 * overwrite is never used (the merge would undo it). [Roll this vault back] previews every
 * change (items created since the backup that would be deleted, items restored, newer values
 * replaced) and applies it as ONE interactive operation; before a secret is replaced its
 * current value goes to password_history with changed_by = 'rollback'. [Restore as a new vault]
 * forks the backup into a new file with a new lineage (file-binding.forkAsSeparateVault).
 * Parts: restore-types, restore-read (staged backup read), restore-plan (the comparison).
 */

import { formatIsoMs } from './canonical.js';
import { previewField, previewRow } from './candidates-shared.js';
import { LIFE_DEAD, LIFE_LIVE, LIFE_REG, regKey } from './catalog.js';
import { prepareWrite } from './capture-local.js';
import { uuidV4 } from './conflicts-shared.js';
import { forkAsSeparateVault, type ForkResult } from './file-binding.js';
import { SYNC_LOG_PREFIX, type SyncHost } from './host.js';
import { planRollback, type FieldPlan } from './restore-plan.js';
import { CHANGED_BY_ROLLBACK, type RollbackInput, type RollbackPreview } from './restore-types.js';
import { provisionalValue } from './state-view.js';
import { TBL, type LocalWrite, type RegKey, type RowKey, type SyncContext, type SyncState } from './types.js';

export * from './restore-types.js';
export { readBackupContent } from './restore-read.js';

const REPLACE_ALL = 'replace-all';
const UUID_RANDOM_BYTES = 16;
const HISTORY_REGS = { entryId: 'entry_id', username: 'username', password: 'password', changedAt: 'changed_at', changedBy: 'changed_by' } as const;
const USERNAME_REG = 'username';

export function rollbackPreview(input: RollbackInput): RollbackPreview {
  const plan = planRollback(input);
  return {
    deletions: plan.deletions,
    restorations: plan.rows.filter((r) => r.kind === 'restore').map((r) => previewRow(r.row, r.title)),
    replacements: plan.rows
      .filter((r) => r.kind === 'update')
      .flatMap((r) => r.fields.map((f) => previewField(f.key, r.title, f.current, f.incoming))),
    unreadableSecrets: plan.unreadableSecrets,
  };
}

export interface RollbackChange {
  readonly writes: readonly LocalWrite[];
  /**
   * What the user rolled back, counted as the preview lists it: one per item deleted, one per
   * row restored (its values included) and one per value replaced. writes.length counts
   * registers and the password_history rows the rollback adds.
   */
  readonly changes: number;
}

/**
 * Writes for replica.applyWrites({interactive: true}): per catalog register the backup's value
 * where it differs canonically (secrets compared by keyed vhash after decrypting with the
 * backup keys and re-encrypting via prepareWrite plaintext); `_life = dead` for rows absent from
 * the backup; `_life = live` plus values for rows only in the backup; one new password_history
 * row (changed_by = CHANGED_BY_ROLLBACK) per replaced non-empty password.
 */
export function rollbackChange(input: RollbackInput): RollbackChange {
  const { ctx, current } = input;
  const plan = planRollback(input);
  const writes: LocalWrite[] = plan.deletions.map((d) => lifeWrite(d.row, LIFE_DEAD, ctx));
  let changes = plan.deletions.length;
  for (const row of plan.rows) {
    if (row.kind === 'restore') writes.push(lifeWrite(row.row, LIFE_LIVE, ctx));
    changes += row.kind === 'restore' ? 1 : row.fields.length;
    for (const f of row.fields) {
      if (f.replacedPlaintext !== null) writes.push(...historyWrites(current, f.key.rowId, f.replacedPlaintext, ctx));
      writes.push(fieldWrite(f, ctx));
    }
  }
  return { writes, changes };
}

export function rollbackWrites(input: RollbackInput): readonly LocalWrite[] {
  return rollbackChange(input).writes;
}

/** [Restore as a new vault]: forkAsSeparateVault from the backup file. */
export async function restoreAsNewVault(
  backupPath: string,
  key: Buffer,
  targetPath: string,
  workDir: string,
  host: Pick<SyncHost, 'fs' | 'random' | 'clock' | 'logger'>,
): Promise<ForkResult> {
  try {
    const res = await forkAsSeparateVault({ sourcePath: backupPath, key, targetPath, workDir }, host);
    host.logger.info(`${SYNC_LOG_PREFIX} backup restored as a new vault`, { lineageId: res.lineageId });
    return res;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    host.logger.error(`${SYNC_LOG_PREFIX} restore as a new vault failed`, { code: typeof code === 'string' ? code : String((err as Error)?.name) });
    throw err;
  }
}

function lifeWrite(row: RowKey, value: string, ctx: SyncContext): LocalWrite {
  return prepareWrite(regKey(row.tbl, row.rowId, LIFE_REG), { value }, ctx, REPLACE_ALL);
}

function fieldWrite(f: FieldPlan, ctx: SyncContext): LocalWrite {
  return prepareWrite(f.key, f.secret ? { plaintext: f.plaintext } : { value: f.incoming }, ctx, REPLACE_ALL);
}

/** A new password_history row keeping the password the rollback replaces (5.10). */
function historyWrites(current: SyncState, entryId: string, plaintext: string, ctx: SyncContext): LocalWrite[] {
  const id = uuidV4(ctx.randomBytes(UUID_RANDOM_BYTES));
  const k = (reg: string): RegKey => regKey(TBL.history, id, reg);
  const username = provisionalValue(current, regKey(TBL.entries, entryId, USERNAME_REG), null) ?? null;
  return [
    prepareWrite(k(LIFE_REG), { value: LIFE_LIVE }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.entryId), { value: entryId }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.username), { value: username }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.password), { plaintext }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.changedAt), { value: formatIsoMs(ctx.now()) }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.changedBy), { value: CHANGED_BY_ROLLBACK }, ctx, REPLACE_ALL),
  ];
}
