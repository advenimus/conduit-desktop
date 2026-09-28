import { useEffect, useMemo } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { DatabaseIcon, HistoryIcon } from "../../lib/icons";
import { Button, Spinner } from "../ui";

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
          <HistoryIcon size={16} className="text-ink-muted" />
          <span className="text-label font-semibold text-ink-secondary">Backup History</span>
        </div>
        {limitLabel && (
          <span className="text-badge text-ink-muted">{limitLabel}</span>
        )}
      </div>

      {loadingBackups ? (
        <Spinner size={12} text="Loading backups..." className="py-2 text-label text-ink-muted" />
      ) : cloudBackups.length === 0 ? (
        <p className="text-label text-ink-muted py-1">
          No backup snapshots yet. Backups are created automatically each time your vault syncs.
        </p>
      ) : (
        <div className="flex items-center justify-between py-2 px-3 rounded-md bg-well">
          <div className="flex items-center gap-2">
            <DatabaseIcon size={16} className="text-ink-muted" />
            <span className="text-label text-ink-secondary">
              {cloudBackups.length} backup{cloudBackups.length !== 1 ? "s" : ""} across{" "}
              {vaultCount} vault{vaultCount !== 1 ? "s" : ""}
            </span>
          </div>
          <Button variant="link" size="sm" onClick={onOpenManager}>
            Manage Backups...
          </Button>
        </div>
      )}
    </div>
  );
}
