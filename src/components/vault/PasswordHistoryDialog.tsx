import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { useAuthStore } from "../../stores/authStore";
import { useTeamStore } from "../../stores/teamStore";
import { getPasswordHistoryLimit } from "../../lib/tier";
import type { PasswordHistoryEntry } from "../../types/entry";
import {
  ClockIcon, CloseIcon, CopyIcon, EyeIcon, EyeOffIcon, HistoryIcon, LoaderIcon, LockIcon, TrashIcon, UserIcon
} from "../../lib/icons";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[520px] max-h-[600px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-conduit-500/10 flex items-center justify-center">
              <HistoryIcon size={18} className="text-conduit-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">Password History</h2>
              <p className="text-xs text-ink-muted truncate max-w-[340px]">{entryName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded text-ink-muted hover:text-ink"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
            </div>
          )}

          {!loading && history.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <HistoryIcon size={32} className="text-ink-faint mb-2" />
              <p className="text-sm text-ink-muted">No password changes recorded yet</p>
            </div>
          )}

          {!loading && history.length > 0 && (
            <div className="space-y-2">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="border border-stroke-dim rounded-md px-3 py-2.5 hover:bg-well/30 transition-colors"
                >
                  {/* Timestamp row */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <ClockIcon size={13} className="text-ink-faint" />
                      {new Date(entry.changed_at).toLocaleString()}
                    </div>
                    <div className="flex items-center gap-0.5">
                      {entry.password && (
                        <>
                          <button
                            onClick={() => togglePasswordVisibility(entry.id)}
                            title={visiblePasswords.has(entry.id) ? "Hide password" : "Show password"}
                            className="p-1 rounded hover:bg-raised text-ink-muted hover:text-ink transition-colors"
                          >
                            {visiblePasswords.has(entry.id) ? (
                              <EyeOffIcon size={14} />
                            ) : (
                              <EyeIcon size={14} />
                            )}
                          </button>
                          <button
                            onClick={() => copyToClipboard(entry.password!, "Password")}
                            title="Copy password"
                            className="p-1 rounded hover:bg-raised text-ink-muted hover:text-ink transition-colors"
                          >
                            <CopyIcon size={14} />
                          </button>
                        </>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(entry.id)}
                          title="Delete history entry"
                          className="p-1 rounded hover:bg-raised text-ink-muted hover:text-red-400 transition-colors"
                        >
                          <TrashIcon size={14} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Username */}
                  {entry.username && (
                    <div className="flex items-center gap-1.5 text-xs mb-1">
                      <UserIcon size={13} className="text-ink-faint" />
                      <span className="text-ink-muted">Username</span>
                      <span className="text-ink">{entry.username}</span>
                    </div>
                  )}

                  {/* Password */}
                  {entry.password && (
                    <div className="flex items-center gap-1.5 text-xs mb-1">
                      <LockIcon size={13} className="text-ink-faint" />
                      <span className="text-ink-muted">Password</span>
                      <span className="text-ink font-mono">
                        {visiblePasswords.has(entry.id) ? entry.password : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}
                      </span>
                    </div>
                  )}

                  {/* Changed by */}
                  {entry.changed_by && (
                    <div className="text-[11px] text-ink-faint mt-1">
                      Changed by {entry.changed_by}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-stroke px-4 py-3 flex items-center justify-between">
          {isFreeTier ? (
            <p className="text-[11px] text-ink-faint">
              Free plan shows {limit} most recent changes.{" "}
              <button
                onClick={() => invoke("auth_open_pricing")}
                className="text-conduit-400 hover:text-conduit-300 underline"
              >
                Upgrade for full history.
              </button>
            </p>
          ) : (
            <div />
          )}
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-raised hover:bg-stroke rounded text-ink transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
