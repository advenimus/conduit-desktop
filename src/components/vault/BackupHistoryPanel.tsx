import { useEffect, useMemo } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { DatabaseIcon, HistoryIcon } from "../../lib/icons";

interface Props {
  onOpenManager: () => void;
}

export default function BackupHistoryPanel({ onOpenManager }: Props) {
  const {
    cloudBackups,
    cloudBackupRetentionDays,
    loadingBackups,
    listCloudBackups,
    getCloudBackupRetention,
  } = useVaultStore();
  const profile = useAuthStore((s) => s.profile);

  useEffect(() => {
    listCloudBackups();
    getCloudBackupRetention();
  }, [listCloudBackups, getCloudBackupRetention]);

  const tierName = profile?.is_team_member ? "Team" : (profile?.tier?.display_name ?? "Free");
  const limitLabel =
    cloudBackupRetentionDays === -1
      ? `Retain backups indefinitely (${tierName})`
      : cloudBackupRetentionDays !== null && cloudBackupRetentionDays > 0
      ? `Retain backups for ${cloudBackupRetentionDays} day${cloudBackupRetentionDays !== 1 ? "s" : ""} (${tierName})`
      : null;

  const vaultCount = useMemo(
    () => new Set(cloudBackups.map((b) => b.vaultId)).size,
    [cloudBackups],
  );

  return (
    <div className="pt-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <HistoryIcon size={14} className="text-ink-muted" />
          <span className="text-xs font-medium text-ink-secondary">Backup History</span>
        </div>
        {limitLabel && (
          <span className="text-[10px] text-ink-muted">{limitLabel}</span>
        )}
      </div>

      {loadingBackups ? (
        <div className="flex items-center gap-2 py-2">
          <div className="w-3 h-3 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-ink-muted">Loading backups...</span>
        </div>
      ) : cloudBackups.length === 0 ? (
        <p className="text-xs text-ink-muted py-1">
          No backup snapshots yet. Backups are created automatically each time your vault syncs.
        </p>
      ) : (
        <div className="flex items-center justify-between py-2 px-3 rounded bg-well/50">
          <div className="flex items-center gap-2">
            <DatabaseIcon size={14} className="text-ink-muted" />
            <span className="text-xs text-ink-secondary">
              {cloudBackups.length} backup{cloudBackups.length !== 1 ? "s" : ""} across{" "}
              {vaultCount} vault{vaultCount !== 1 ? "s" : ""}
            </span>
          </div>
          <button
            onClick={onOpenManager}
            className="px-3 py-1.5 text-xs font-medium text-conduit-400 hover:bg-conduit-600/10 rounded"
          >
            Manage Backups...
          </button>
        </div>
      )}
    </div>
  );
}
