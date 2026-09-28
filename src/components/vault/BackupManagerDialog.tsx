import { useEffect, useMemo, useState } from "react";
import { useVaultStore, type CloudBackupEntry } from "../../stores/vaultStore";
import { useAuthStore } from "../../stores/authStore";
import { CloudOffIcon, LockIcon } from "../../lib/icons";
import { Badge, Button, Dialog, DialogFooter, DialogHeader, ListRow, Spinner, TextInput } from "../ui";

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

  const cancelRestore = () => {
    setRestorePath(null);
    setRestoreVaultName(null);
    setRestorePassword("");
    setRestoreError(null);
  };

  return (
    <Dialog
      open
      title="Backup Manager"
      width={672}
      layer="sync"
      onClose={onClose}
      layout="custom"
      data-cv-backup-manager=""
    >
      <DialogHeader />

      <div className="flex h-[400px] border-y border-divider">
        <div className="w-48 border-r border-divider overflow-y-auto p-2 flex-shrink-0">
          {loadingBackups ? (
            <Spinner size={12} text="Loading..." className="p-2 text-label text-ink-muted" />
          ) : vaultGroups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <CloudOffIcon size={20} className="text-ink-faint" />
              <span className="text-label text-ink-muted">No backups found</span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {vaultGroups.map((group) => {
                const isCurrent = group.vaultName === currentVaultName;
                const count = `${group.backups.length} backup${group.backups.length !== 1 ? "s" : ""}`;
                return (
                  <ListRow
                    key={group.vaultId}
                    selected={group.vaultId === selectedVaultId}
                    leading="database"
                    description={isCurrent ? `(current) ${count}` : count}
                    onClick={() => {
                      setSelectedVaultId(group.vaultId);
                      cancelRestore();
                    }}
                  >
                    <span className="font-medium">{group.vaultName}</span>
                  </ListRow>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto p-4 flex flex-col">
          {!selectedGroup ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="text-label text-ink-muted">Select a vault to view backups</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-body font-semibold text-ink">{selectedGroup.vaultName}</h3>
                {selectedGroup.vaultName === currentVaultName && <Badge>(current)</Badge>}
              </div>

              <div className="space-y-4 flex-1">
                {dateGroups.map((group) => (
                  <div key={group.label}>
                    <h4 className="text-meta font-semibold text-ink-muted mb-2">{group.label}</h4>
                    <div className="space-y-1.5">
                      {group.backups.map((backup) => (
                        <div key={backup.path} className="py-2 px-3 rounded-md bg-well text-label">
                          {restorePath === backup.path ? (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-ink-secondary">{formatTime(backup.created_at)}</span>
                                <span className="text-ink-muted">{formatBytes(backup.size)}</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <div className="flex-1">
                                  <TextInput
                                    type="password"
                                    value={restorePassword}
                                    onChange={(e) => setRestorePassword(e.target.value)}
                                    onKeyDown={(e) => e.key === "Enter" && handleRestore()}
                                    placeholder="Master password"
                                    autoFocus
                                    leading={<LockIcon size={12} />}
                                  />
                                </div>
                                <Button variant="primary" size="sm" onClick={handleRestore} disabled={restoring || !restorePassword}>
                                  {restoring ? "..." : "Confirm"}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={cancelRestore}>
                                  Cancel
                                </Button>
                              </div>
                              {restoreError && (
                                <p data-cv-error="" className="text-meta text-danger">
                                  {restoreError}
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <span className="text-ink-secondary">{formatTime(backup.created_at)}</span>
                                {backup.size > 0 && <span className="text-ink-muted">{formatBytes(backup.size)}</span>}
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="restore"
                                onClick={() => {
                                  setRestorePath(backup.path);
                                  setRestoreVaultName(backup.vaultName);
                                  setRestorePassword("");
                                  setRestoreError(null);
                                }}
                              >
                                Restore
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {retentionLabel && (
                <div className="mt-4 pt-3 border-t border-divider">
                  <span className="text-badge text-ink-muted">{retentionLabel}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button onClick={onClose}>Close</Button>
      </DialogFooter>
    </Dialog>
  );
}
