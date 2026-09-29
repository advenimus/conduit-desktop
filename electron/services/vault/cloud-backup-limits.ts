/**
 * Cloud backup limits the server enforces (docs/PLAN_ENFORCEMENT.md 2.9, 4.10): the snapshot
 * cap per vault (`max_cloud_backups`) and the vault-folder cap per account
 * (`max_cloud_backup_vaults`), the count prune that keeps an honest client under the snapshot
 * cap, and how a refused upload reads in the backup status line (S16, S17, S24).
 */

export const MAX_CLOUD_BACKUPS_FEATURE = 'max_cloud_backups';
export const MAX_CLOUD_BACKUP_VAULTS_FEATURE = 'max_cloud_backup_vaults';

export const CLOUD_BACKUP_REFUSED_MESSAGE = 'Cloud backup needs Pro or Team. Your earlier backups are still here.';
export const CLOUD_BACKUP_FULL_MESSAGE = 'Cloud backup is full. Conduit removes the oldest backup before the next one.';

export function cloudBackupVaultsFullMessage(vaults: number | null): string {
  const plan = vaults === null ? 'a limited number of' : String(vaults);
  return `Cloud backup is full: your plan backs up ${plan} vaults. Remove an old vault's backups to back up this one.`;
}

/** Why the last upload was refused; the status line shows it (null when nothing was refused). */
export type CloudBackupNotice =
  | { readonly kind: 'plan' }
  | { readonly kind: 'full' }
  | { readonly kind: 'vaults-full'; readonly vaults: number | null };

export function noticeMessage(notice: CloudBackupNotice): string {
  switch (notice.kind) {
    case 'plan':
      return CLOUD_BACKUP_REFUSED_MESSAGE;
    case 'full':
      return CLOUD_BACKUP_FULL_MESSAGE;
    case 'vaults-full':
      return cloudBackupVaultsFullMessage(notice.vaults);
  }
}

/** A tier feature that is a whole number (-1 unlimited), else null. */
export function tierLimit(features: unknown, key: string): number | null {
  if (typeof features !== 'object' || features === null) return null;
  const v = (features as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= -1 ? v : null;
}

/** A Storage refusal by a storage.objects policy (HTTP 403 or the RLS message). */
export function isPolicyRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 403 || e.statusCode === 403 || e.statusCode === '403') return true;
  return typeof e.message === 'string' && /row-level security/i.test(e.message);
}

export interface SnapshotObject {
  readonly path: string;
  readonly created_at: string;
}

/**
 * Snapshots to remove before a new one so at most `cap - 1` remain (the newest are kept). An
 * unknown or unlimited cap removes nothing; names sort by time too, so equal dates keep order.
 */
export function countPruneTargets(backups: readonly SnapshotObject[], cap: number | null): readonly string[] {
  if (cap === null || cap === -1 || cap < 1) return [];
  const newestFirst = [...backups].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.path.localeCompare(a.path));
  return newestFirst.slice(cap - 1).map((b) => b.path);
}
