import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { useAuthStore } from "../../stores/authStore";
import { useTeamStore } from "../../stores/teamStore";
import { getPasswordHistoryLimit } from "../../lib/tier";
import type { PasswordHistoryEntry } from "../../types/entry";
import { ClockIcon, LockIcon, UserIcon } from "../../lib/icons";
import { Button, Dialog, EmptyState, IconButton, Spinner } from "../ui";

interface PasswordHistoryDialogProps {
  entryId: string;
  entryName: string;
  onClose: () => void;
}

export default function PasswordHistoryDialog({ entryId, entryName, onClose }: PasswordHistoryDialogProps) {
  const [history, setHistory] = useState<PasswordHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const { profile, authMode } = useAuthStore();
  const { myVaultRole } = useTeamStore();
  const [vaultType, setVaultType] = useState<string>("personal");

  const limit = getPasswordHistoryLimit(profile, authMode);

  const loadHistory = async () => {
    setLoading(true);
    try {
      const entries = await invoke<PasswordHistoryEntry[]>("password_history_list", {
        entry_id: entryId,
        limit,
      });
      setHistory(entries);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load password history");
    } finally {
      setLoading(false);
    }
  };

  const loadVaultType = async () => {
    try {
      const type = await invoke<string>("vault_get_type");
      setVaultType(type);
    } catch {
      // Default to personal if we can't determine vault type
    }
  };

  useEffect(() => {
    loadHistory();
    loadVaultType();
  }, [entryId]);

  const handleDelete = async (historyId: string) => {
    try {
      await invoke("password_history_delete", { id: historyId });
      setHistory((prev) => prev.filter((h) => h.id !== historyId));
      toast.success("History entry deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete history entry");
    }
  };

  const togglePasswordVisibility = (id: string) => {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  const canDelete = vaultType === "personal" || myVaultRole === "admin";
  const isFreeTier = limit > 0 && limit !== -1;

  const footer = (
    <>
      {isFreeTier && (
        <p className="mr-auto self-center text-meta text-ink-faint">
          Free plan shows {limit} most recent changes.{" "}
          <Button variant="link" size="sm" onClick={() => invoke("auth_open_pricing")} className="underline">
            Upgrade for full history.
          </Button>
        </p>
      )}
      <Button onClick={onClose}>Close</Button>
    </>
  );

  return (
    <Dialog
      open
      title="Password History"
      icon="history"
      width={520}
      style={{ maxHeight: 600 }}
      closeOnEscape={false}
      onClose={onClose}
      footer={footer}
    >
      <p className="-mt-2 max-w-[376px] truncate pl-9 text-label text-ink-muted">{entryName}</p>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size={24} className="text-ink-muted" />
        </div>
      )}

      {!loading && history.length === 0 && (
        <div className="py-4">
          <EmptyState icon="history" title="No password changes recorded yet" />
        </div>
      )}

      {!loading && history.length > 0 && (
        <div className="space-y-2">
          {history.map((entry) => {
            const visible = visiblePasswords.has(entry.id);
            return (
              <div key={entry.id} className="rounded-md border border-card-border px-3 py-2.5 transition-colors hover:bg-hover">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-label text-ink-muted">
                    <ClockIcon size={12} compact className="text-ink-faint" />
                    {new Date(entry.changed_at).toLocaleString()}
                  </div>
                  <div className="flex items-center gap-0.5">
                    {entry.password && (
                      <>
                        <IconButton
                          size="sm"
                          icon={visible ? "eyeOff" : "eye"}
                          label={visible ? "Hide password" : "Show password"}
                          onClick={() => togglePasswordVisibility(entry.id)}
                        />
                        <IconButton size="sm" icon="copy" label="Copy password" onClick={() => copyToClipboard(entry.password!, "Password")} />
                      </>
                    )}
                    {canDelete && (
                      <IconButton size="sm" icon="trash" tone="danger" label="Delete history entry" onClick={() => handleDelete(entry.id)} />
                    )}
                  </div>
                </div>

                {entry.username && (
                  <div className="mb-1 flex items-center gap-1.5 text-label">
                    <UserIcon size={12} compact className="text-ink-faint" />
                    <span className="text-ink-muted">Username</span>
                    <span className="text-ink">{entry.username}</span>
                  </div>
                )}

                {entry.password && (
                  <div className="mb-1 flex items-center gap-1.5 text-label">
                    <LockIcon size={12} compact className="text-ink-faint" />
                    <span className="text-ink-muted">Password</span>
                    <span className="font-mono text-ink">{visible ? entry.password : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}</span>
                  </div>
                )}

                {entry.changed_by && <div className="mt-1 text-meta text-ink-faint">Changed by {entry.changed_by}</div>}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
