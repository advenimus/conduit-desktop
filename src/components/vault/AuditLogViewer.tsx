import { useState, useEffect, useCallback } from "react";
import { useTeamStore, type AuditLogEntry } from "../../stores/teamStore";
import { CheckIcon, FileIcon, FolderIcon, LockIcon, MailIcon, ShieldLockIcon, UsersIcon } from "../../lib/icons";
import { Badge, Button, Dialog, DialogFooter, DialogHeader, EmptyState, Spinner, cx } from "../ui";

interface AuditLogViewerProps {
  teamVaultId?: string;
  /** When true, renders just the filter sidebar + log body without a modal wrapper. */
  embedded?: boolean;
  onClose?: () => void;
}

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  entry_create: { label: "Created entry", color: "text-success" },
  entry_update: { label: "Updated entry", color: "text-warning" },
  entry_delete: { label: "Deleted entry", color: "text-danger" },
  entry_view: { label: "Viewed entry", color: "text-link" },
  password_changed: { label: "Password changed", color: "text-warning" },
  password_history_delete: { label: "Deleted password history", color: "text-danger" },
  folder_create: { label: "Created folder", color: "text-success" },
  folder_update: { label: "Updated folder", color: "text-warning" },
  folder_delete: { label: "Deleted folder", color: "text-danger" },
  member_add: { label: "Added member", color: "text-success" },
  member_remove: { label: "Removed member", color: "text-danger" },
  member_role_change: { label: "Changed role", color: "text-warning" },
  vault_create: { label: "Created vault", color: "text-success" },
  vault_delete: { label: "Deleted vault", color: "text-danger" },
  vault_access: { label: "Accessed vault", color: "text-link" },
  permission_grant: { label: "Granted permission", color: "text-success" },
  permission_revoke: { label: "Revoked permission", color: "text-danger" },
  invitation_sent: { label: "Sent invitation", color: "text-link" },
  invitation_accepted: { label: "Accepted invitation", color: "text-success" },
  invitation_declined: { label: "Declined invitation", color: "text-warning" },
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
    return "bg-success";
  }
  if (
    action.endsWith("_delete") ||
    action === "member_remove" ||
    action === "permission_revoke"
  ) {
    return "bg-danger";
  }
  if (
    action.endsWith("_update") ||
    action === "member_role_change" ||
    action === "invitation_declined"
  ) {
    return "bg-warning";
  }
  return "bg-accent";
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
    <div className={cx(embedded ? "w-[180px]" : "w-[220px]", "shrink-0 overflow-y-auto border-r border-divider p-3")}>
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={toggleAll}
          className={cx(
            "flex items-center gap-2 text-label font-medium transition-colors",
            allSelected ? "text-ink" : "text-ink-secondary hover:text-ink",
          )}
        >
          <FilterBox checked={allSelected} />
          All Events
        </button>
        {filterActions.length > 0 && (
          <button type="button" onClick={selectAll} className="text-badge text-ink-faint transition-colors hover:text-ink-secondary">
            Clear
          </button>
        )}
      </div>

      <div className="space-y-3">
        {ACTION_CATEGORIES.map((cat) => {
          const CatIcon = cat.icon;
          const activeCount = activeCountForCategory(cat.actions);
          const totalCount = cat.actions.length;

          return (
            <div key={cat.group}>
              <div className="mb-1.5 flex items-center gap-1.5">
                <CatIcon size={12} compact className="text-ink-faint" />
                <span className="text-meta font-semibold text-ink-muted">{cat.group}</span>
                {filterActions.length > 0 && activeCount > 0 && (
                  <Badge className="ml-auto">
                    {activeCount}/{totalCount}
                  </Badge>
                )}
              </div>

              <div className="space-y-0.5">
                {cat.actions.map((action) => {
                  const info = ACTION_LABELS[action];
                  const isActive = filterActions.length === 0 || filterActions.includes(action);

                  return (
                    <button
                      type="button"
                      key={action}
                      onClick={() => {
                        if (filterActions.length === 0) {
                          setFilterActions(ALL_ACTIONS.filter((a) => a !== action));
                        } else if (filterActions.includes("__none__")) {
                          setFilterActions([action]);
                        } else {
                          toggleAction(action);
                        }
                      }}
                      className="flex h-row w-full items-center gap-2 rounded px-1.5 text-left transition-colors hover:bg-hover"
                    >
                      <FilterBox checked={isActive} />
                      <span className="truncate text-label text-ink-secondary">{info?.label ?? action}</span>
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
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-divider px-4 py-2">
        <span className="text-label text-ink-muted">
          Showing {allEntries.length} event{allEntries.length !== 1 ? "s" : ""}
        </span>
        {loading && <Spinner size={12} className="text-ink-muted" />}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-3">
        {loading && allEntries.length === 0 && (
          <div className="flex items-center justify-center py-12">
            <Spinner size={24} className="text-ink-muted" />
          </div>
        )}

        {!loading && allEntries.length === 0 && (
          <EmptyState
            icon="history"
            title="No activity found."
            className="my-4"
            action={
              filterActions.length > 0 ? (
                <Button variant="link" size="sm" onClick={selectAll}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        )}

        {Array.from(dateGroups.entries()).map(([dateKey, entries], i) => (
          <div key={dateKey} className="mb-4">
            <p className={cx("sticky top-0 z-10 mb-2 bg-overlay py-1 text-meta font-semibold text-ink-muted", i === 0 && "pt-3")}>
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
                  <div key={entry.id} className="group flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-hover">
                    <div className={cx("w-1 shrink-0 self-stretch rounded-full", accent)} />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="max-w-[180px] truncate text-label font-medium text-ink">
                          {entry.actor_display_name || entry.actor_email}
                        </span>
                        <span className={cx("text-label", info.color)}>{info.label}</span>
                        {entry.target_name && (
                          <span className="max-w-[200px] truncate text-label text-ink-secondary">
                            &ldquo;{entry.target_name}&rdquo;
                          </span>
                        )}
                        {entry.target_type && <Badge>{entry.target_type}</Badge>}
                      </div>
                    </div>

                    <span className="shrink-0 pt-0.5 text-meta text-ink-faint">{formatTime(entry.created_at)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {hasMore && allEntries.length > 0 && (
          <div className="flex justify-center pb-4 pt-2">
            <Button onClick={handleLoadMore} disabled={loading}>
              {loading ? "Loading..." : "Load More"}
            </Button>
          </div>
        )}

        <p className="py-2 text-center text-meta text-ink-faint">Audit logs are retained for 2 years.</p>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1">
        {filterSidebar}
        {logPanel}
      </div>
    );
  }

  const close = onClose ?? (() => {});
  return (
    <Dialog open title="Audit Log" icon="history" width={900} closeOnEscape={false} onClose={close} layout="custom">
      <DialogHeader />
      {team?.name && <p className="-mt-2 pb-3 pl-13 pr-4 text-label text-ink-muted">{team.name}</p>}

      <div className="flex min-h-0 flex-1 border-y border-divider">
        {filterSidebar}
        {logPanel}
      </div>

      <DialogFooter divided>
        <Button onClick={close}>Close</Button>
      </DialogFooter>
    </Dialog>
  );
}

function FilterBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
        checked ? "border-btn-primary bg-btn-primary" : "border-(--c-checkbox-border) bg-(--c-checkbox-bg)",
      )}
    >
      {checked && <CheckIcon size={12} compact className="text-white" />}
    </span>
  );
}
