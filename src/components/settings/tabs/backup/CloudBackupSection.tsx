import { useState } from "react";
import { useVaultStore } from "../../../../stores/vaultStore";
import type { CloudBackupNotice, CloudSyncState } from "../../../../stores/vaultStore";
import { invoke } from "../../../../lib/electron";
import { cloudBackupNoticeText } from "./cloud-backup-notice";
import { CloudIcon, CloudOffIcon } from "../../../../lib/icons";
import { toast } from "../../../common/Toast";
import BackupHistoryPanel from "../../../vault/BackupHistoryPanel";
import { Badge, Button } from "../../../ui";
import { HINT } from "../../settings-styles";
import { BackupToggleRow } from "./BackupToggleRow";
import { errorText } from "../../../../lib/errorText";

function statusText(state: CloudSyncState): string {
  if (state.status === "synced" && state.lastSyncedAt) return `Last backup: ${new Date(state.lastSyncedAt).toLocaleString()}`;
  if (state.status === "syncing") return "Backing up...";
  if (state.status === "error") return `Error: ${state.error}`;
  return "No cloud backup yet";
}

function openPricing(): void {
  invoke("auth_open_pricing").catch((err) => {
    console.error("[backup] Failed to open pricing:", err);
    toast.error("Could not open the pricing page");
  });
}

/** S16, S17, S24: why the server refused the last upload. */
function NoticeLine({ notice }: { notice: CloudBackupNotice }) {
  return (
    <div data-cv-cloud-backup-notice={notice.kind} className="flex items-center gap-2">
      <p className="text-label text-warning">{cloudBackupNoticeText(notice)}</p>
      {notice.kind === "plan" && (
        <Button size="sm" onClick={openPricing}>
          Upgrade
        </Button>
      )}
    </div>
  );
}

interface CloudBackupSectionProps {
  allowed: boolean;
  onOpenManager: () => void;
}

/** Settings > Backup > Cloud Backup (signed in): the toggle, Back Up Now, delete and the history. */
export function CloudBackupSection({ allowed, onOpenManager }: CloudBackupSectionProps) {
  const { cloudSyncState, enableCloudSync, disableCloudSync, syncNow, deleteCloudVault } = useVaultStore();
  const [syncing, setSyncing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggle = async () => {
    if (!allowed) return;
    setSyncing(true);
    try {
      if (cloudSyncState?.enabled) await disableCloudSync();
      else await enableCloudSync();
    } catch (err) {
      console.error("[backup] Failed to toggle cloud backup:", err);
      toast.error("Could not change cloud backup", errorText(err, "Try again."));
    } finally {
      setSyncing(false);
    }
  };

  const backUpNow = async () => {
    setSyncing(true);
    try {
      await syncNow();
    } catch (err) {
      toast.error("Cloud backup failed", errorText(err, "Try again."));
    } finally {
      setSyncing(false);
    }
  };

  const deleteBackup = async () => {
    try {
      await deleteCloudVault();
      await disableCloudSync();
    } catch (err) {
      console.error("[backup] Failed to delete cloud backup:", err);
      toast.error("Could not delete the cloud backup", errorText(err, "Try again."));
    }
    setConfirmDelete(false);
  };

  const enabled = cloudSyncState?.enabled === true;
  const notice = cloudSyncState?.notice ?? null;
  // A refusal's notice replaces the error line; S17 rides next to a successful backup.
  const showStatus = !(notice !== null && cloudSyncState?.status === "error");

  return (
    <div data-cv-cloud-backup-section="" className="space-y-3 border-t border-divider pt-4">
      <BackupToggleRow
        icon={enabled ? <CloudIcon size={16} className="text-(--c-accent)" /> : <CloudOffIcon size={16} className="text-ink-muted" />}
        title="Cloud Backup"
        aside={!allowed && <Badge data-cv-cloud-backup-badge="" tone="accent">Pro and Team</Badge>}
        checked={enabled}
        disabled={syncing || !allowed}
        onChange={() => void toggle()}
      />

      {notice !== null && <NoticeLine notice={notice} />}
      {cloudSyncState?.enabled && (
        <>
          {showStatus && <p className="text-label text-ink-muted">{statusText(cloudSyncState)}</p>}
          <div className="flex items-center gap-2">
            <Button size="sm" loading={syncing} loadingLabel="Backing up..." onClick={() => void backUpNow()}>
              Back Up Now
            </Button>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <Button variant="danger" size="sm" onClick={() => void deleteBackup()}>
                  Confirm Delete
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost-danger" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete Cloud Backup
              </Button>
            )}
          </div>

          <BackupHistoryPanel onOpenManager={onOpenManager} />
        </>
      )}

      <p className={HINT}>
        {allowed
          ? "Your vault is encrypted before upload. Only you can read it. To use a vault on several devices, keep it in a synced folder."
          : "Upgrade to Pro or Team to back up your vault to the cloud. It is encrypted before upload."}
      </p>
    </div>
  );
}
