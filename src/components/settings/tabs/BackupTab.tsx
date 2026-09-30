import { useState, useEffect } from "react";
import { useAuthStore } from "../../../stores/authStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useAiStore } from "../../../stores/aiStore";
import BackupManagerDialog from "../../vault/BackupManagerDialog";
import { HINT } from "../settings-styles";
import { CloudBackupSection } from "./backup/CloudBackupSection";
import { LocalBackupSection } from "./backup/LocalBackupSection";

export default function BackupTab() {
  const { user, authMode } = useAuthStore();
  const { fetchCloudSyncState, isUnlocked, fetchLocalBackupState, listLocalBackups } = useVaultStore();
  const cloudSyncAllowed = useAiStore((s) => s.tierCapabilities?.cloud_sync_enabled ?? false);
  const [showBackupManager, setShowBackupManager] = useState(false);

  useEffect(() => {
    fetchCloudSyncState();
    fetchLocalBackupState();
    listLocalBackups();
  }, [fetchCloudSyncState, fetchLocalBackupState, listLocalBackups]);

  return (
    <div className="space-y-4">
      {isUnlocked ? (
        <LocalBackupSection />
      ) : (
        <div className="py-4 text-center">
          <p className={HINT}>Unlock your vault to configure local backups</p>
        </div>
      )}

      {user && isUnlocked && authMode === "authenticated" && (
        <CloudBackupSection allowed={cloudSyncAllowed} onOpenManager={() => setShowBackupManager(true)} />
      )}

      {showBackupManager && <BackupManagerDialog onClose={() => setShowBackupManager(false)} />}
    </div>
  );
}
