import { useEffect, useState } from "react";
import { listen } from "../../../../lib/electron";
import { useVaultStore } from "../../../../stores/vaultStore";
import type { LocalBackupState } from "../../../../stores/vaultStore";
import { FloppyIcon, FolderIcon, TrashIcon } from "../../../../lib/icons";
import { toast } from "../../../common/Toast";
import { Button, IconButton, TextInput } from "../../../ui";
import { formatFileSize } from "../../SettingsHelpers";
import { HINT, SECTION_LABEL } from "../../settings-styles";
import { BackupToggleRow, errorMessage } from "./BackupToggleRow";

function statusText(state: LocalBackupState): string {
  if (state.status === "backed-up" && state.lastBackedUpAt) return `Last backup: ${new Date(state.lastBackedUpAt).toLocaleString()}`;
  if (state.status === "backing-up") return "Backing up...";
  if (state.status === "error") return `Error: ${state.error}`;
  return "No backups yet";
}

/** Settings > Backup > Local Backup: the toggle, folder, retention, Backup Now and the file list. */
export function LocalBackupSection() {
  const {
    localBackupState, localBackups,
    setLocalBackupState, enableLocalBackup, disableLocalBackup,
    localBackupNow, deleteLocalBackup, updateLocalBackupSettings, selectLocalBackupFolder,
  } = useVaultStore();

  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (localBackupState) {
      setFolder(localBackupState.backupPath);
      setRetentionDays(localBackupState.retentionDays);
    }
  }, [localBackupState]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<LocalBackupState>("local-backup:state-changed", (event) => {
      setLocalBackupState(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [setLocalBackupState]);

  const toggle = async () => {
    setBusy(true);
    try {
      if (localBackupState?.enabled) {
        await disableLocalBackup();
      } else {
        const chosen = folder || await selectLocalBackupFolder();
        if (!chosen) return;
        setFolder(chosen);
        await enableLocalBackup(chosen);
      }
    } catch (err) {
      toast.error("Could not change local backup", errorMessage(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const changeFolder = async () => {
    const chosen = await selectLocalBackupFolder();
    if (!chosen) return;
    setBusy(true);
    try {
      await disableLocalBackup();
      setFolder(chosen);
      await enableLocalBackup(chosen);
    } catch (err) {
      toast.error("Could not change the backup folder", errorMessage(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      await localBackupNow();
    } catch (err) {
      toast.error("Backup failed", errorMessage(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  const deleteBackup = async (fullPath: string) => {
    try {
      await deleteLocalBackup(fullPath);
    } catch (err) {
      toast.error("Could not delete the backup", errorMessage(err, "Try again."));
    }
    setConfirmDelete(null);
  };

  const enabled = localBackupState?.enabled === true;

  return (
    <div className="space-y-3">
      <BackupToggleRow
        icon={<FloppyIcon size={16} className={enabled ? "text-(--c-accent)" : "text-ink-muted"} />}
        title="Local Backup"
        checked={enabled}
        disabled={busy}
        onChange={() => void toggle()}
      />

      {localBackupState?.enabled && (
        <>
          <div>
            <label className={`${SECTION_LABEL} mb-1`}>Backup Folder</label>
            <div className="flex items-center gap-2">
              <div className="flex h-control min-w-0 flex-1 items-center truncate rounded border border-input-border bg-input px-1.5 text-label text-ink-muted">
                {localBackupState.backupPath ?? "Not set"}
              </div>
              <IconButton icon={FolderIcon} label="Change backup folder" onClick={() => void changeFolder()} />
            </div>
          </div>

          <div>
            <label className={`${SECTION_LABEL} mb-1`}>Retention Period</label>
            <div className="flex items-center gap-2">
              <span className="block w-20">
                <TextInput
                  type="number"
                  value={retentionDays}
                  onChange={(e) => setRetentionDays(Math.max(1, parseInt(e.target.value) || 30))}
                  onBlur={() => updateLocalBackupSettings({ retentionDays })}
                  min={1}
                />
              </span>
              <span className="text-label text-ink-muted">days</span>
            </div>
            <p className={`mt-0.5 ${HINT}`}>Backups older than this are automatically deleted</p>
          </div>

          <p className="text-label text-ink-muted">{statusText(localBackupState)}</p>

          <div className="flex items-center gap-2">
            <Button size="sm" loading={busy} loadingLabel="Working..." onClick={() => void backupNow()}>
              Backup Now
            </Button>
          </div>

          {localBackups.length > 0 && (
            <div>
              <label className={`${SECTION_LABEL} mb-1`}>Backup Files ({localBackups.length})</label>
              <div data-cv-backup-files="" className="max-h-32 overflow-y-auto rounded border border-card-border">
                {localBackups.map((backup) => (
                  <div
                    key={backup.fullPath}
                    data-cv-backup-row=""
                    className="flex items-center justify-between border-b border-divider px-2 py-1.5 text-label last:border-b-0 hover:bg-hover"
                  >
                    <div className="min-w-0 flex-1">
                      <span data-cv-backup-name="" className="block truncate text-ink-secondary">{backup.name}</span>
                      <span data-cv-backup-meta="" className="text-meta text-ink-muted">
                        {new Date(backup.created_at).toLocaleString()} - {formatFileSize(backup.size)}
                      </span>
                    </div>
                    {confirmDelete === backup.fullPath ? (
                      <div className="ml-2 flex items-center gap-1">
                        <Button variant="danger" size="sm" onClick={() => void deleteBackup(backup.fullPath)}>
                          Delete
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                          No
                        </Button>
                      </div>
                    ) : (
                      <IconButton
                        size="sm"
                        icon={TrashIcon}
                        tone="danger"
                        label="Delete backup"
                        className="ml-2"
                        onClick={() => setConfirmDelete(backup.fullPath)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <p className={HINT}>
        Backups are encrypted with your master password using AES-256-GCM before writing to disk. No account required.
      </p>
    </div>
  );
}
