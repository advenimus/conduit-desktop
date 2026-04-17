import { useEffect, useMemo, useState } from "react";
import { useVaultStore, type CloudBackupEntry } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import {
  CloseIcon, CloudOffIcon, DatabaseIcon, LockIcon, RestoreIcon
} from "../../lib/icons";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (target.getTime() === today.getTime()) return "Today";
  if (target.getTime() === yesterday.getTime()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface VaultGroup {
  vaultId: string;
  vaultName: string;
  backups: CloudBackupEntry[];
}

interface DateGroup {
  label: string;
  backups: CloudBackupEntry[];
}

interface Props {
  onClose: () => void;
}

export default function BackupManagerDialog({ onClose }: Props) {
  const {
    cloudBackups,
    cloudBackupRetentionDays,
    loadingBackups,
    listCloudBackups,
    getCloudBackupRetention,
    restoreFromBackup,
    currentVaultPath,
  } = useVaultStore();
  const profile = useAuthStore((s) => s.profile);

  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [restoreVaultName, setRestoreVaultName] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    listCloudBackups();
    getCloudBackupRetention();
  }, [listCloudBackups, getCloudBackupRetention]);

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Derive current vault name from path
  const currentVaultName = useMemo(() => {
    if (!currentVaultPath) return null;
    const filename = currentVaultPath.split(/[/\\]/).pop() ?? "Vault";
    return filename.replace(".conduit", "") || "Vault";
  }, [currentVaultPath]);

  // Group backups by vault, current vault first
  const vaultGroups = useMemo((): VaultGroup[] => {
    const groupMap = new Map<string, VaultGroup>();

    for (const backup of cloudBackups) {
      const key = backup.vaultId;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          vaultId: backup.vaultId,
          vaultName: backup.vaultName,
          backups: [],
        });
      }
      groupMap.get(key)!.backups.push(backup);
    }

    const groups = Array.from(groupMap.values());

    groups.sort((a, b) => {
      const aIsCurrent = a.vaultName === currentVaultName;
      const bIsCurrent = b.vaultName === currentVaultName;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return a.vaultName.localeCompare(b.vaultName);
    });

    return groups;
  }, [cloudBackups, currentVaultName]);

  // Auto-select first vault when groups load
  useEffect(() => {
    if (vaultGroups.length > 0 && !selectedVaultId) {
      setSelectedVaultId(vaultGroups[0].vaultId);
    }
  }, [vaultGroups, selectedVaultId]);

  // Get backups for selected vault
  const selectedGroup = useMemo(
    () => vaultGroups.find((g) => g.vaultId === selectedVaultId) ?? null,
    [vaultGroups, selectedVaultId],
  );

  // Group selected backups by date
  const dateGroups = useMemo((): DateGroup[] => {
    if (!selectedGroup) return [];

    const sorted = [...selectedGroup.backups].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );

    const groups: DateGroup[] = [];
    let currentLabel = "";

    for (const backup of sorted) {
      const label = getDateLabel(backup.created_at);
      if (label !== currentLabel) {
        currentLabel = label;
        groups.push({ label, backups: [] });
      }
      groups[groups.length - 1].backups.push(backup);
    }

    return groups;
  }, [selectedGroup]);

  const tierName = profile?.is_team_member ? "Team" : (profile?.tier?.display_name ?? "Free");
  const retentionLabel =
    cloudBackupRetentionDays === -1
      ? `Retain backups indefinitely (${tierName})`
      : cloudBackupRetentionDays !== null && cloudBackupRetentionDays > 0
      ? `Retain backups for ${cloudBackupRetentionDays} day${cloudBackupRetentionDays !== 1 ? "s" : ""} (${tierName})`
      : null;

  const handleRestore = async () => {
    if (!restorePath || !restorePassword) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreFromBackup(restorePath, restorePassword, restoreVaultName ?? undefined);
      setRestorePath(null);
      setRestoreVaultName(null);
      setRestorePassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Restore failed";
      setRestoreError(msg);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="w-full max-w-2xl bg-panel border border-stroke rounded-lg shadow-xl mx-4 flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-stroke flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Backup Manager</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded text-ink-muted hover:text-ink"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex h-[400px]">
          {/* Sidebar */}
          <div className="w-48 border-r border-stroke overflow-y-auto p-2 flex-shrink-0">
            {loadingBackups ? (
              <div className="flex items-center gap-2 p-2">
                <div className="w-3 h-3 border-2 border-conduit-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-ink-muted">Loading...</span>
              </div>
            ) : vaultGroups.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-4 text-center">
                <CloudOffIcon size={20} className="text-ink-faint" />
                <span className="text-xs text-ink-muted">No backups found</span>
              </div>
            ) : (
              <div className="space-y-1">
                {vaultGroups.map((group) => {
                  const isActive = group.vaultId === selectedVaultId;
                  const isCurrent = group.vaultName === currentVaultName;
                  return (
                    <button
                      key={group.vaultId}
                      onClick={() => {
                        setSelectedVaultId(group.vaultId);
                        setRestorePath(null);
                        setRestorePassword("");
                        setRestoreError(null);
                      }}
                      className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
                        isActive
                          ? "bg-conduit-600/20 text-conduit-400 border border-conduit-600/30"
                          : "hover:bg-raised border border-transparent text-ink-secondary"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <DatabaseIcon size={12} className={isActive ? "text-conduit-400" : "text-ink-muted"} />
                        <span className="font-medium truncate">{group.vaultName}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 pl-[18px]">
                        {isCurrent && (
                          <span className="text-[9px] text-ink-muted">(current)</span>
                        )}
                        <span className="text-[10px] text-ink-muted">
                          {group.backups.length} backup{group.backups.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto p-4 flex flex-col">
            {!selectedGroup ? (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-xs text-ink-muted">Select a vault to view backups</span>
              </div>
            ) : (
              <>
                {/* Vault name header */}
                <div className="flex items-center gap-2 mb-4">
                  <h3 className="text-sm font-medium text-ink">{selectedGroup.vaultName}</h3>
                  {selectedGroup.vaultName === currentVaultName && (
                    <span className="text-[10px] text-ink-muted bg-raised px-1.5 py-0.5 rounded">(current)</span>
                  )}
                </div>

                {/* Date-grouped backups */}
                <div className="space-y-4 flex-1">
                  {dateGroups.map((group) => (
                    <div key={group.label}>
                      <h4 className="text-xs font-medium text-ink-muted mb-2">{group.label}</h4>
                      <div className="space-y-1.5">
                        {group.backups.map((backup) => {
                          const isRestoringThis = restorePath === backup.path;

                          return (
                            <div
                              key={backup.path}
                              className="py-2 px-3 rounded bg-well/50 text-xs"
                            >
                              {isRestoringThis ? (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <span className="text-ink-secondary">{formatTime(backup.created_at)}</span>
                                    <span className="text-ink-muted">{formatBytes(backup.size)}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <div className="relative flex-1">
                                      <LockIcon size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-muted" />
                                      <input
                                        type="password"
                                        value={restorePassword}
                                        onChange={(e) => setRestorePassword(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleRestore()}
                                        placeholder="Master password"
                                        autoFocus
                                        className="w-full pl-7 pr-2 py-1.5 text-xs bg-canvas border border-stroke rounded focus:outline-none focus:ring-1 focus:ring-conduit-500"
                                      />
                                    </div>
                                    <button
                                      onClick={handleRestore}
                                      disabled={restoring || !restorePassword}
                                      className="px-2.5 py-1.5 text-[10px] font-medium text-white bg-conduit-600 hover:bg-conduit-700 rounded disabled:opacity-50"
                                    >
                                      {restoring ? "..." : "Confirm"}
                                    </button>
                                    <button
                                      onClick={() => {
                                        setRestorePath(null);
                                        setRestoreVaultName(null);
                                        setRestorePassword("");
                                        setRestoreError(null);
                                      }}
                                      className="px-2 py-1.5 text-[10px] hover:bg-raised rounded text-ink-secondary"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                  {restoreError && (
                                    <p className="text-xs text-red-400">{restoreError}</p>
                                  )}
                                </div>
                              ) : (
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <span className="text-ink-secondary">{formatTime(backup.created_at)}</span>
                                    {backup.size > 0 && (
                                      <span className="text-ink-muted">{formatBytes(backup.size)}</span>
                                    )}
                                  </div>
                                  <button
                                    onClick={() => {
                                      setRestorePath(backup.path);
                                      setRestoreVaultName(backup.vaultName);
                                      setRestorePassword("");
                                      setRestoreError(null);
                                    }}
                                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-ink-secondary hover:bg-raised rounded"
                                  >
                                    <RestoreIcon size={12} />
                                    Restore
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Retention info */}
                {retentionLabel && (
                  <div className="mt-4 pt-3 border-t border-stroke">
                    <span className="text-[10px] text-ink-muted">{retentionLabel}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-stroke flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-secondary hover:bg-raised rounded"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
