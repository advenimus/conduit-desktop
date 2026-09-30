import { useState, useEffect } from "react";
import { listen } from "../../../lib/electron";
import { useAuthStore } from "../../../stores/authStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { LocalBackupState } from "../../../stores/vaultStore";
import { useAiStore } from "../../../stores/aiStore";
import BackupHistoryPanel from "../../vault/BackupHistoryPanel";
import BackupManagerDialog from "../../vault/BackupManagerDialog";
import { formatFileSize } from "../SettingsHelpers";
import { toast } from "../../common/Toast";
import {
  CloudIcon, CloudOffIcon, FloppyIcon, FolderIcon, TrashIcon
} from "../../../lib/icons";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function BackupTab() {
  const { user, authMode } = useAuthStore();
  const {
    cloudSyncState, enableCloudSync, disableCloudSync, syncNow, deleteCloudVault, fetchCloudSyncState, isUnlocked,
    localBackupState, localBackups,
    fetchLocalBackupState, setLocalBackupState, enableLocalBackup, disableLocalBackup,
    localBackupNow, listLocalBackups, deleteLocalBackup, updateLocalBackupSettings, selectLocalBackupFolder,
  } = useVaultStore();
  const tierCapabilities = useAiStore((s) => s.tierCapabilities);
  const cloudSyncAllowed = tierCapabilities?.cloud_sync_enabled ?? false;

  const [showBackupManager, setShowBackupManager] = useState(false);
  const [showDeleteCloudConfirm, setShowDeleteCloudConfirm] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);

  // Local backup UI state
  const [localBackupBusy, setLocalBackupBusy] = useState(false);
  const [localBackupFolder, setLocalBackupFolder] = useState<string | null>(null);
  const [localRetentionDays, setLocalRetentionDays] = useState(30);
  const [showDeleteLocalConfirm, setShowDeleteLocalConfirm] = useState<string | null>(null);

  useEffect(() => {
    fetchCloudSyncState();
    fetchLocalBackupState();
    listLocalBackups();
  }, [fetchCloudSyncState, fetchLocalBackupState, listLocalBackups]);

  // Sync local backup state into local UI state
  useEffect(() => {
    if (localBackupState) {
      setLocalBackupFolder(localBackupState.backupPath);
      setLocalRetentionDays(localBackupState.retentionDays);
    }
  }, [localBackupState]);

  // Listen for local backup state changes from main process
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<LocalBackupState>("local-backup:state-changed", (event) => {
      setLocalBackupState(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [setLocalBackupState]);

  return (
    <div className="space-y-4">
      {/* Section 1: Local Backup */}
      {isUnlocked && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FloppyIcon size={16} className={localBackupState?.enabled ? "text-conduit-400" : "text-ink-muted"} />
              <label className="text-sm font-medium">Local Backup</label>
            </div>
            <button
              onClick={async () => {
                setLocalBackupBusy(true);
                try {
                  if (localBackupState?.enabled) {
                    await disableLocalBackup();
                  } else {
                    const folder = localBackupFolder || await selectLocalBackupFolder();
                    if (!folder) {
                      setLocalBackupBusy(false);
                      return;
                    }
                    setLocalBackupFolder(folder);
                    await enableLocalBackup(folder);
                  }
                } catch (err) {
                  toast.error("Could not change local backup", errorMessage(err, "Try again."));
                } finally {
                  setLocalBackupBusy(false);
                }
              }}
              disabled={localBackupBusy}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                localBackupState?.enabled ? "bg-conduit-600" : "bg-well"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  localBackupState?.enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {localBackupState?.enabled && (
            <>
              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">Backup Folder</label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-1.5 bg-well border border-stroke rounded text-xs text-ink-muted truncate">
                    {localBackupState.backupPath ?? "Not set"}
                  </div>
                  <button
                    onClick={async () => {
                      const folder = await selectLocalBackupFolder();
                      if (folder) {
                        setLocalBackupBusy(true);
                        try {
                          await disableLocalBackup();
                          setLocalBackupFolder(folder);
                          await enableLocalBackup(folder);
                        } catch (err) {
                          toast.error("Could not change the backup folder", errorMessage(err, "Try again."));
                        } finally {
                          setLocalBackupBusy(false);
                        }
                      }
                    }}
                    className="px-2 py-1.5 text-xs bg-raised hover:bg-well rounded"
                  >
                    <FolderIcon size={14} />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-secondary mb-1">Retention Period</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={localRetentionDays}
                    onChange={(e) => {
                      const val = Math.max(1, parseInt(e.target.value) || 30);
                      setLocalRetentionDays(val);
                    }}
                    onBlur={() => {
                      updateLocalBackupSettings({ retentionDays: localRetentionDays });
                    }}
                    min={1}
                    className="w-20 px-3 py-1.5 bg-well border border-stroke rounded text-xs focus:outline-none focus:ring-2 focus:ring-conduit-500"
                  />
                  <span className="text-xs text-ink-muted">days</span>
                </div>
                <p className="text-[10px] text-ink-muted mt-0.5">Backups older than this are automatically deleted</p>
              </div>

              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span>
                  {localBackupState.status === "backed-up" && localBackupState.lastBackedUpAt
                    ? `Last backup: ${new Date(localBackupState.lastBackedUpAt).toLocaleString()}`
                    : localBackupState.status === "backing-up"
                    ? "Backing up..."
                    : localBackupState.status === "error"
                    ? `Error: ${localBackupState.error}`
                    : "No backups yet"}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setLocalBackupBusy(true);
                    try { await localBackupNow(); } catch (err) {
                      toast.error("Backup failed", errorMessage(err, "Try again."));
                    } finally { setLocalBackupBusy(false); }
                  }}
                  disabled={localBackupBusy}
                  className="px-3 py-1.5 text-xs bg-raised hover:bg-well rounded disabled:opacity-50"
                >
                  {localBackupBusy ? "Working..." : "Backup Now"}
                </button>
              </div>

              {localBackups.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-ink-secondary mb-1">
                    Backup Files ({localBackups.length})
                  </label>
                  <div className="max-h-32 overflow-y-auto border border-stroke rounded">
                    {localBackups.map((backup) => (
                      <div key={backup.fullPath} className="flex items-center justify-between px-2 py-1.5 text-xs border-b border-stroke last:border-b-0 hover:bg-raised/50">
                        <div className="flex-1 min-w-0">
                          <span className="text-ink-secondary truncate block">{backup.name}</span>
                          <span className="text-[10px] text-ink-muted">
                            {new Date(backup.created_at).toLocaleString()} - {formatFileSize(backup.size)}
                          </span>
                        </div>
                        {showDeleteLocalConfirm === backup.fullPath ? (
                          <div className="flex items-center gap-1 ml-2">
                            <button
                              onClick={async () => {
                                try { await deleteLocalBackup(backup.fullPath); } catch (err) {
                                  toast.error("Could not delete the backup", errorMessage(err, "Try again."));
                                }
                                setShowDeleteLocalConfirm(null);
                              }}
                              className="px-1.5 py-0.5 text-[10px] text-white bg-red-600 hover:bg-red-700 rounded"
                            >
                              Delete
                            </button>
                            <button
                              onClick={() => setShowDeleteLocalConfirm(null)}
                              className="px-1.5 py-0.5 text-[10px] hover:bg-raised rounded"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setShowDeleteLocalConfirm(backup.fullPath)}
                            className="p-1 text-ink-muted hover:text-red-400 hover:bg-red-500/10 rounded ml-2"
                          >
                            <TrashIcon size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <p className="text-xs text-ink-muted">
            Backups are encrypted with your master password using AES-256-GCM before writing to disk. No account required.
          </p>
        </div>
      )}

      {!isUnlocked && (
        <div className="text-center py-4">
          <p className="text-xs text-ink-muted">Unlock your vault to configure local backups</p>
        </div>
      )}

      {/* Section 2: Cloud Backup */}
      {user && isUnlocked && authMode === 'authenticated' && (
        <div className="pt-4 border-t border-stroke space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {cloudSyncState?.enabled ? (
                <CloudIcon size={16} className="text-conduit-400" />
              ) : (
                <CloudOffIcon size={16} className="text-ink-muted" />
              )}
              <label className="text-sm font-medium">Cloud Backup</label>
              {!cloudSyncAllowed && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-conduit-600/20 text-conduit-400 rounded">Pro and Team</span>
              )}
            </div>
            <button
              onClick={async () => {
                if (!cloudSyncAllowed) return;
                setCloudSyncing(true);
                try {
                  if (cloudSyncState?.enabled) {
                    await disableCloudSync();
                  } else {
                    await enableCloudSync();
                  }
                } catch (err) {
                  console.error("[backup] Failed to toggle cloud backup:", err);
                  toast.error("Could not change cloud backup", errorMessage(err, "Try again."));
                } finally {
                  setCloudSyncing(false);
                }
              }}
              disabled={cloudSyncing || !cloudSyncAllowed}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                cloudSyncState?.enabled ? "bg-conduit-600" : "bg-well"
              } ${!cloudSyncAllowed ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  cloudSyncState?.enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {cloudSyncState?.enabled && (
            <>
              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span>
                  {cloudSyncState.status === "synced" && cloudSyncState.lastSyncedAt
                    ? `Last backup: ${new Date(cloudSyncState.lastSyncedAt).toLocaleString()}`
                    : cloudSyncState.status === "syncing"
                    ? "Backing up..."
                    : cloudSyncState.status === "error"
                    ? `Error: ${cloudSyncState.error}`
                    : "No cloud backup yet"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setCloudSyncing(true);
                    try { await syncNow(); } catch (err) {
                      toast.error("Cloud backup failed", errorMessage(err, "Try again."));
                    }
                    finally { setCloudSyncing(false); }
                  }}
                  disabled={cloudSyncing}
                  className="px-3 py-1.5 text-xs bg-raised hover:bg-well rounded disabled:opacity-50"
                >
                  {cloudSyncing ? "Backing up..." : "Back Up Now"}
                </button>
                {showDeleteCloudConfirm ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={async () => {
                        try {
                          await deleteCloudVault();
                          await disableCloudSync();
                        } catch (err) {
                          console.error("[backup] Failed to delete cloud backup:", err);
                          toast.error("Could not delete the cloud backup", errorMessage(err, "Try again."));
                        }
                        setShowDeleteCloudConfirm(false);
                      }}
                      className="px-2 py-1 text-xs text-white bg-red-600 hover:bg-red-700 rounded"
                    >
                      Confirm Delete
                    </button>
                    <button
                      onClick={() => setShowDeleteCloudConfirm(false)}
                      className="px-2 py-1 text-xs hover:bg-raised rounded"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowDeleteCloudConfirm(true)}
                    className="px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 rounded"
                  >
                    Delete Cloud Backup
                  </button>
                )}
              </div>

              <BackupHistoryPanel onOpenManager={() => setShowBackupManager(true)} />
            </>
          )}

          <p className="text-xs text-ink-muted">
            {cloudSyncAllowed
              ? "Your vault is encrypted before upload. Only you can read it. To use a vault on several devices, keep it in a synced folder."
              : "Upgrade to Pro or Team to back up your vault to the cloud. It is encrypted before upload."}
          </p>
        </div>
      )}

      {showBackupManager && <BackupManagerDialog onClose={() => setShowBackupManager(false)} />}
    </div>
  );
}
