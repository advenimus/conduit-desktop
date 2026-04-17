import { useState, useEffect, useCallback } from "react";
import { useTeamStore, type AuditLogEntry } from "../../stores/teamStore";
import {
  CheckIcon, CloseIcon, FileIcon, FolderIcon, HistoryIcon, LoaderIcon, LockIcon, MailIcon, ShieldLockIcon, UsersIcon
} from "../../lib/icons";

interface AuditLogViewerProps {
  teamVaultId?: string;
  /** When true, renders just the filter sidebar + log body without a modal wrapper. */
  embedded?: boolean;
  onClose?: () => void;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  entry_create: { label: "Created entry", color: "text-green-400" },
  entry_update: { label: "Updated entry", color: "text-yellow-400" },
  entry_delete: { label: "Deleted entry", color: "text-red-400" },
  entry_view: { label: "Viewed entry", color: "text-conduit-400" },
  password_changed: { label: "Password changed", color: "text-yellow-400" },
  password_history_delete: { label: "Deleted password history", color: "text-red-400" },
  folder_create: { label: "Created folder", color: "text-green-400" },
  folder_update: { label: "Updated folder", color: "text-yellow-400" },
  folder_delete: { label: "Deleted folder", color: "text-red-400" },
  member_add: { label: "Added member", color: "text-green-400" },
  member_remove: { label: "Removed member", color: "text-red-400" },
  member_role_change: { label: "Changed role", color: "text-yellow-400" },
  vault_create: { label: "Created vault", color: "text-green-400" },
  vault_delete: { label: "Deleted vault", color: "text-red-400" },
  vault_access: { label: "Accessed vault", color: "text-conduit-400" },
  permission_grant: { label: "Granted permission", color: "text-green-400" },
  permission_revoke: { label: "Revoked permission", color: "text-red-400" },
  invitation_sent: { label: "Sent invitation", color: "text-conduit-400" },
  invitation_accepted: { label: "Accepted invitation", color: "text-green-400" },
  invitation_declined: { label: "Declined invitation", color: "text-yellow-400" },
};

const ACTION_CATEGORIES = [
  { group: "Entries", icon: FileIcon, actions: ["entry_create", "entry_update", "entry_delete", "entry_view", "password_changed", "password_history_delete"] },
  { group: "Folders", icon: FolderIcon, actions: ["folder_create", "folder_update", "folder_delete"] },
  { group: "Members", icon: UsersIcon, actions: ["member_add", "member_remove", "member_role_change"] },
  { group: "Vault", icon: LockIcon, actions: ["vault_create", "vault_delete", "vault_access"] },
  { group: "Permissions", icon: ShieldLockIcon, actions: ["permission_grant", "permission_revoke"] },
  { group: "Invitations", icon: MailIcon, actions: ["invitation_sent", "invitation_accepted", "invitation_declined"] },
];

const ALL_ACTIONS = ACTION_CATEGORIES.flatMap((c) => c.actions);

const PAGE_SIZE = 50;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return "Today";
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function groupByDate(entries: AuditLogEntry[]): Map<string, AuditLogEntry[]> {
  const groups = new Map<string, AuditLogEntry[]>();
  for (const entry of entries) {
    const dateKey = new Date(entry.created_at).toDateString();
    const existing = groups.get(dateKey) ?? [];
    existing.push(entry);
    groups.set(dateKey, existing);
  }
  return groups;
}

function getAccentColor(action: string): string {
  if (
    action.endsWith("_create") ||
    action === "member_add" ||
    action === "permission_grant" ||
    action === "invitation_accepted"
  ) {
    return "bg-green-500";
  }
  if (
    action.endsWith("_delete") ||
    action === "member_remove" ||
    action === "permission_revoke"
  ) {
    return "bg-red-500";
  }
  if (
    action.endsWith("_update") ||
    action === "member_role_change" ||
    action === "invitation_declined"
  ) {
    return "bg-yellow-500";
  }
  return "bg-conduit-500";
}

export default function AuditLogViewer({ teamVaultId, embedded, onClose }: AuditLogViewerProps) {
  const { auditLog, loadAuditLog, team } = useTeamStore();

  const [loading, setLoading] = useState(true);
  const [filterActions, setFilterActions] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [allEntries, setAllEntries] = useState<AuditLogEntry[]>([]);

  const fetchLogs = useCallback(
    async (append = false) => {
      if (!team) return;
      setLoading(true);
      try {
        await loadAuditLog({
          teamVaultId,
          actions: filterActions.length > 0 ? filterActions : undefined,
          limit: PAGE_SIZE,
          offset: append ? offset : 0,
        });
        if (!append) setOffset(0);
      } finally {
        setLoading(false);
      }
    },
    [team, teamVaultId, filterActions, offset, loadAuditLog]
  );

  useEffect(() => {
    setAllEntries([]);
    fetchLogs();
  }, [filterActions, teamVaultId]);

  useEffect(() => {
    if (auditLog.length === 0) return;
    setAllEntries((prev) => {
      if (offset === 0) {
        return auditLog;
      }
      const existingIds = new Set(prev.map((e) => e.id));
      const newEntries = auditLog.filter((e) => !existingIds.has(e.id));
      return [...prev, ...newEntries];
    });
    setHasMore(auditLog.length >= PAGE_SIZE);
  }, [auditLog]);

  const handleLoadMore = async () => {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    setLoading(true);
    try {
      await loadAuditLog({
        teamVaultId,
        actions: filterActions.length > 0 ? filterActions : undefined,
        limit: PAGE_SIZE,
        offset: newOffset,
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleAction = (action: string) => {
    setFilterActions((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]
    );
  };

  const allSelected = filterActions.length === 0;

  const toggleAll = () => {
    if (allSelected) {
      // Deselect all — pass a sentinel so the API query matches nothing
      setFilterActions(["__none__"]);
    } else {
      // Select all — empty array means no filter (show everything)
      setFilterActions([]);
    }
  };

  const selectAll = () => {
    setFilterActions([]);
  };

  const activeCountForCategory = (actions: string[]) => {
    if (filterActions.length === 0) return actions.length; // all shown
    return actions.filter((a) => filterActions.includes(a)).length;
  };

  const dateGroups = groupByDate(allEntries);

  const filterSidebar = (
    <div className={`${embedded ? "w-[180px]" : "w-[220px]"} flex-shrink-0 border-r border-stroke${embedded ? "/50" : ""} overflow-y-auto p-3`}>
      {/* Select All / Clear All */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={toggleAll}
          className={`flex items-center gap-2 text-xs font-medium transition-colors ${
            allSelected ? "text-conduit-400" : "text-ink-secondary hover:text-ink"
          }`}
        >
          <span
            className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center ${
              allSelected
                ? "bg-conduit-500 border-conduit-500"
                : "border-ink-faint"
            }`}
          >
            {allSelected && <CheckIcon size={10} className="text-white" />}
          </span>
          All Events
        </button>
        {filterActions.length > 0 && (
          <button
            onClick={selectAll}
            className="text-[10px] text-ink-faint hover:text-ink-secondary transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Category groups */}
      <div className="space-y-3">
        {ACTION_CATEGORIES.map((cat) => {
          const CatIcon = cat.icon;
          const activeCount = activeCountForCategory(cat.actions);
          const totalCount = cat.actions.length;

          return (
            <div key={cat.group}>
              {/* Category header */}
              <div className="flex items-center gap-1.5 mb-1.5">
                <CatIcon size={13} className="text-ink-faint" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                  {cat.group}
                </span>
                {filterActions.length > 0 && activeCount > 0 && (
                  <span className="text-[9px] px-1 py-px rounded-full bg-conduit-600/20 text-conduit-400 ml-auto">
                    {activeCount}/{totalCount}
                  </span>
                )}
              </div>

              {/* Action checkboxes */}
              <div className="space-y-0.5">
                {cat.actions.map((action) => {
                  const info = ACTION_LABELS[action];
                  const isActive =
                    filterActions.length === 0 || filterActions.includes(action);

                  return (
                    <button
                      key={action}
                      onClick={() => {
                        if (filterActions.length === 0) {
                          setFilterActions(
                            ALL_ACTIONS.filter((a) => a !== action)
                          );
                        } else if (filterActions.includes("__none__")) {
                          setFilterActions([action]);
                        } else {
                          toggleAction(action);
                        }
                      }}
                      className="flex items-center gap-2 w-full px-1.5 py-1 rounded-md text-left hover:bg-well/50 transition-colors"
                    >
                      <span
                        className={`w-3 h-3 rounded-sm border flex items-center justify-center flex-shrink-0 ${
                          isActive
                            ? "bg-conduit-500 border-conduit-500"
                            : "border-ink-faint"
                        }`}
                      >
                        {isActive && (
                          <CheckIcon size={9} className="text-white" />
                        )}
                      </span>
                      <span className="text-xs text-ink-secondary truncate">
                        {info?.label ?? action}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const logPanel = (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Sub-header: count + loading */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-stroke/50">
        <span className="text-xs text-ink-muted">
          Showing {allEntries.length} event{allEntries.length !== 1 ? "s" : ""}
        </span>
        {loading && (
          <LoaderIcon size={14} className="text-conduit-400 animate-spin" />
        )}
      </div>

      {/* Scrollable log body */}
      <div className="flex-1 overflow-y-auto px-4 pb-3">
        {loading && allEntries.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <LoaderIcon size={24} className="text-conduit-400 animate-spin" />
          </div>
        )}

        {!loading && allEntries.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12">
            <HistoryIcon size={32} className="text-ink-faint mb-2" />
            <p className="text-sm text-ink-muted">No activity found.</p>
            {filterActions.length > 0 && (
              <button
                onClick={selectAll}
                className="mt-2 text-xs text-conduit-400 hover:text-conduit-300"
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {Array.from(dateGroups.entries()).map(([dateKey, entries], i) => (
          <div key={dateKey} className="mb-4">
            <p className={`text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2 sticky top-0 z-10 bg-panel py-1 ${i === 0 ? "pt-3" : ""}`}>
              {formatDate(entries[0].created_at)}
            </p>
            <div className="space-y-1">
              {entries.map((entry) => {
                const info = ACTION_LABELS[entry.action] ?? {
                  label: entry.action,
                  color: "text-ink-secondary",
                };
                const accent = getAccentColor(entry.action);

                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-well/50 transition-colors group"
                  >
                    {/* Color accent bar */}
                    <div
                      className={`w-1 self-stretch rounded-full flex-shrink-0 ${accent}`}
                    />

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-ink truncate max-w-[180px]">
                          {entry.actor_display_name || entry.actor_email}
                        </span>
                        <span className={`text-xs ${info.color}`}>
                          {info.label}
                        </span>
                        {entry.target_name && (
                          <span className="text-xs text-ink-secondary truncate max-w-[200px]">
                            &ldquo;{entry.target_name}&rdquo;
                          </span>
                        )}
                        {entry.target_type && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-well text-ink-muted">
                            {entry.target_type}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Timestamp */}
                    <span className="text-[11px] text-ink-faint flex-shrink-0 pt-0.5">
                      {formatTime(entry.created_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {hasMore && allEntries.length > 0 && (
          <div className="flex justify-center pt-2 pb-4">
            <button
              onClick={handleLoadMore}
              disabled={loading}
              className="px-4 py-2 text-xs text-ink-secondary hover:text-ink rounded-md border border-stroke hover:bg-well transition-colors disabled:opacity-50"
            >
              {loading ? "Loading..." : "Load More"}
            </button>
          </div>
        )}

        {/* Retention notice */}
        <p className="text-center text-[11px] text-ink-faint py-2">
          Audit logs are retained for 2 years.
        </p>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex flex-1 min-h-0">
        {filterSidebar}
        {logPanel}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl w-[900px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stroke">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-conduit-500/10 flex items-center justify-center">
              <HistoryIcon size={18} className="text-conduit-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-ink">Audit Log</h2>
              {team?.name && (
                <p className="text-xs text-ink-muted">{team.name}</p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-raised rounded text-ink-muted hover:text-ink"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        {/* Body: sidebar + main */}
        <div className="flex flex-1 min-h-0">
          {filterSidebar}
          {logPanel}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-4 py-3 border-t border-stroke">
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
