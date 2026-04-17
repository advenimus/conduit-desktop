import { useState, useEffect } from "react";
import { listen } from "../../../lib/electron";
import { useAuthStore } from "../../../stores/authStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { LocalBackupState } from "../../../stores/vaultStore";
import { useAiStore } from "../../../stores/aiStore";
import BackupHistoryPanel from "../../vault/BackupHistoryPanel";
import BackupManagerDialog from "../../vault/BackupManagerDialog";
import { formatFileSize } from "../SettingsHelpers";
import {
  CloudIcon, CloudOffIcon, FloppyIcon, FolderIcon, MessageIcon, TrashIcon
} from "../../../lib/icons";

export default function BackupTab() {
  const { user, authMode } = useAuthStore();
  const {
    cloudSyncState, enableCloudSync, disableCloudSync, syncNow, deleteCloudVault, fetchCloudSyncState, isUnlocked,
    localBackupState, localBackups,
    fetchLocalBackupState, setLocalBackupState, enableLocalBackup, disableLocalBackup,
    localBackupNow, listLocalBackups, deleteLocalBackup, updateLocalBackupSettings, selectLocalBackupFolder,
  } = useVaultStore();
  const tierCapabilities = useAiStore((s) => s.tierCapabilities);
  const chatSyncState = useAiStore((s) => s.chatSyncState);
  const { enableChatSync, disableChatSync, syncChatNow, deleteChatCloudData, fetchChatSyncState } = useAiStore();
  const cloudSyncAllowed = tierCapabilities?.cloud_sync_enabled ?? false;
  const chatCloudSyncEnabled = tierCapabilities?.chat_cloud_sync_enabled ?? false;

  const [showBackupManager, setShowBackupManager] = useState(false);
  const [showDeleteCloudConfirm, setShowDeleteCloudConfirm] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [showDeleteChatCloudConfirm, setShowDeleteChatCloudConfirm] = useState(false);
  const [chatCloudSyncing, setChatCloudSyncing] = useState(false);
  const [chatSyncError, setChatSyncError] = useState<string | null>(null);

  // Local backup UI state
  const [localBackupBusy, setLocalBackupBusy] = useState(false);
  const [localBackupError, setLocalBackupError] = useState<string | null>(null);
  const [localBackupFolder, setLocalBackupFolder] = useState<string | null>(null);
  const [localRetentionDays, setLocalRetentionDays] = useState(30);
  const [localIncludeChat, setLocalIncludeChat] = useState(true);
  const [showDeleteLocalConfirm, setShowDeleteLocalConfirm] = useState<string | null>(null);

  useEffect(() => {
    fetchCloudSyncState();
    fetchChatSyncState();
    fetchLocalBackupState();
    listLocalBackups();
  }, [fetchCloudSyncState, fetchChatSyncState, fetchLocalBackupState, listLocalBackups]);

  // Sync local backup state into local UI state
  useEffect(() => {
    if (localBackupState) {
      setLocalBackupFolder(localBackupState.backupPath);
      setLocalRetentionDays(localBackupState.retentionDays);
      setLocalIncludeChat(localBackupState.includeChat);
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
                setLocalBackupError(null);
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
                  const msg = err instanceof Error ? err.message : "Failed to toggle local backup";
                  setLocalBackupError(msg);
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
                        setLocalBackupError(null);
                        try {
                          await disableLocalBackup();
                          setLocalBackupFolder(folder);
                          await enableLocalBackup(folder);
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : "Failed to change folder";
                          setLocalBackupError(msg);
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

              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-secondary">Include chat history</span>
                <button
                  onClick={async () => {
                    const newVal = !localIncludeChat;
                    setLocalIncludeChat(newVal);
                    await updateLocalBackupSettings({ includeChat: newVal });
                  }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    localIncludeChat ? "bg-conduit-600" : "bg-well"
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                      localIncludeChat ? "translate-x-5" : "translate-x-1"
                    }`}
                  />
                </button>
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
                    setLocalBackupError(null);
                    try { await localBackupNow(); } catch (err) {
                      const msg = err instanceof Error ? err.message : "Backup failed";
                      setLocalBackupError(msg);
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
                                try { await deleteLocalBackup(backup.fullPath); } catch {}
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

          {localBackupError && (
            <p className="text-xs text-red-400">{localBackupError}</p>
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
              <label className="text-sm font-medium">Cloud Sync</label>
              {!cloudSyncAllowed && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-conduit-600/20 text-conduit-400 rounded">Team</span>
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
                  console.error("Failed to toggle cloud sync:", err);
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
                    ? `Last synced: ${new Date(cloudSyncState.lastSyncedAt).toLocaleString()}`
                    : cloudSyncState.status === "syncing"
                    ? "Syncing..."
                    : cloudSyncState.status === "error"
                    ? `Error: ${cloudSyncState.error}`
                    : "Not synced yet"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setCloudSyncing(true);
                    try { await syncNow(); } catch { /* shown in state */ }
                    finally { setCloudSyncing(false); }
                  }}
                  disabled={cloudSyncing}
                  className="px-3 py-1.5 text-xs bg-raised hover:bg-well rounded disabled:opacity-50"
                >
                  {cloudSyncing ? "Syncing..." : "Sync Now"}
                </button>
                {showDeleteCloudConfirm ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={async () => {
                        try {
                          await deleteCloudVault();
                          await disableCloudSync();
                        } catch (err) {
                          console.error("Failed to delete cloud vault:", err);
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
              ? "Your vault is encrypted before upload. Zero-knowledge architecture — your data cannot be read by anyone but you."
              : "Upgrade to Team to sync your vault across devices with zero-knowledge encryption."}
          </p>
        </div>
      )}

      {/* Section 3: Chat History Sync */}
      {user && authMode === 'authenticated' && (
        <div className="pt-4 border-t border-stroke space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageIcon size={16} className={chatSyncState?.enabled ? "text-conduit-400" : "text-ink-muted"} />
              <label className="text-sm font-medium">Chat History Sync</label>
              {!chatCloudSyncEnabled && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-conduit-600/20 text-conduit-400 rounded">Team</span>
              )}
            </div>
            <button
              onClick={async () => {
                if (!chatCloudSyncEnabled) return;
                setChatCloudSyncing(true);
                setChatSyncError(null);
                try {
                  if (chatSyncState?.enabled) {
                    await disableChatSync();
                  } else {
                    await enableChatSync();
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "Failed to toggle chat sync";
                  setChatSyncError(msg);
                } finally {
                  setChatCloudSyncing(false);
                }
              }}
              disabled={chatCloudSyncing || !chatCloudSyncEnabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                chatSyncState?.enabled ? "bg-conduit-600" : "bg-well"
              } ${!chatCloudSyncEnabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  chatSyncState?.enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {chatSyncState?.enabled && (
            <>
              <div className="flex items-center justify-between text-xs text-ink-muted">
                <span>
                  {chatSyncState.status === "synced" && chatSyncState.lastSyncedAt
                    ? `Last synced: ${new Date(chatSyncState.lastSyncedAt).toLocaleString()}`
                    : chatSyncState.status === "syncing"
                    ? "Syncing..."
                    : chatSyncState.status === "error"
                    ? `Error: ${chatSyncState.error}`
                    : "Not synced yet"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    setChatCloudSyncing(true);
                    setChatSyncError(null);
                    try { await syncChatNow(); } catch (err) {
                      const msg = err instanceof Error ? err.message : "Sync failed";
                      setChatSyncError(msg);
                    } finally { setChatCloudSyncing(false); }
                  }}
                  disabled={chatCloudSyncing}
                  className="px-3 py-1.5 text-xs bg-raised hover:bg-well rounded disabled:opacity-50"
                >
                  {chatCloudSyncing ? "Syncing..." : "Sync Now"}
                </button>
                {showDeleteChatCloudConfirm ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={async () => {
                        setChatSyncError(null);
                        try {
                          await deleteChatCloudData();
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : "Failed to delete cloud data";
                          setChatSyncError(msg);
                        }
                        setShowDeleteChatCloudConfirm(false);
                      }}
                      className="px-2 py-1 text-xs text-white bg-red-600 hover:bg-red-700 rounded"
                    >
                      Confirm Delete
                    </button>
                    <button
                      onClick={() => setShowDeleteChatCloudConfirm(false)}
                      className="px-2 py-1 text-xs hover:bg-raised rounded"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowDeleteChatCloudConfirm(true)}
                    className="px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 rounded"
                  >
                    Delete Cloud History
                  </button>
                )}
              </div>
            </>
          )}

          {chatSyncError && (
            <p className="text-xs text-red-400">{chatSyncError}</p>
          )}

          <p className="text-xs text-ink-muted">
            {chatCloudSyncEnabled
              ? "Chat conversations are encrypted before sync. Zero-knowledge — only your master password can decrypt them."
              : "Upgrade to Team to sync chat history across devices with zero-knowledge encryption."}
          </p>
        </div>
      )}

      {showBackupManager && <BackupManagerDialog onClose={() => setShowBackupManager(false)} />}
    </div>
  );
}
