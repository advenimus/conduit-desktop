import { useMemo } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore, type CloudSyncState, type LocalBackupState, type TeamSyncState } from "../../stores/vaultStore";
import { useTierStore } from "../../stores/tierStore";
import { useAuthStore } from "../../stores/authStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import type { EntryMeta } from "../../types/entry";
import { SearchIcon } from "../../lib/icons";

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

const TYPE_LABELS: Record<string, string> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  command: "Command",
};

const CONNECTION_TYPES = ["ssh", "rdp", "vnc", "web"] as const;

function formatRelativeTime(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return new Date(dateString).toLocaleDateString();
}

export default function DashboardOverview() {
  const { entries, folders, setSelectedEntry, openEntry } = useEntryStore();
  const { cloudSyncState, localBackupState, credentials, teamSyncState } = useVaultStore();
  const { maxConnections, isTrialing, trialDaysRemaining } = useTierStore();
  const { authMode, profile } = useAuthStore();
  const displayName = profile?.display_name?.split(/\s+/)[0] || null;

  const allTags = useMemo(
    () => [...new Set(entries.flatMap((e) => e.tags))],
    [entries],
  );

  const favoriteEntries = useMemo(
    () => entries.filter((e) => e.is_favorite),
    [entries],
  );

  const recentEntries = useMemo(
    () =>
      [...entries]
        .filter((e) => e.entry_type !== "credential")
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 6),
    [entries],
  );

  const typeCounts = useMemo(
    () =>
      entries.reduce(
        (acc, e) => {
          if (e.entry_type !== "credential" && e.entry_type !== "document") {
            acc[e.entry_type] = (acc[e.entry_type] || 0) + 1;
          }
          return acc;
        },
        {} as Record<string, number>,
      ),
    [entries],
  );

  const connectionCount = useMemo(
    () => entries.filter((e) => e.entry_type !== "credential" && e.entry_type !== "document").length,
    [entries],
  );

  const credentialCount = credentials.length;

  const documentCount = useMemo(
    () => entries.filter((e) => e.entry_type === "document").length,
    [entries],
  );

  const handleQuickConnect = () => {
    document.dispatchEvent(new CustomEvent("conduit:quick-connect"));
  };

  const handleSearchFocus = () => {
    document.dispatchEvent(new CustomEvent("conduit:focus-sidebar-search"));
  };

  const handleTagClick = (tag: string) => {
    document.dispatchEvent(
      new CustomEvent("conduit:sidebar-search", { detail: { query: tag } }),
    );
  };

  const handleEntryClick = (id: string) => {
    setSelectedEntry(id);
  };

  const handleEntryDoubleClick = (entry: EntryMeta) => {
    if (entry.entry_type !== "credential") {
      openEntry(entry.id);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-canvas overflow-y-auto h-full">
      <div className="max-w-4xl w-full mx-auto p-6 space-y-6">
        {/* Welcome Bar */}
        <WelcomeBar
          displayName={displayName}
          entryCount={entries.length}
          credentialCount={credentialCount}
          folderCount={folders.length}
          onQuickConnect={handleQuickConnect}
        />

        {/* Search + Tags */}
        <SearchTagSection
          tags={allTags}
          onSearchFocus={handleSearchFocus}
          onTagClick={handleTagClick}
        />

        {/* Favorites + Recently Modified */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FavoritesSection
            entries={favoriteEntries}
            onEntryClick={handleEntryClick}
            onEntryDoubleClick={handleEntryDoubleClick}
          />
          <RecentlyModifiedSection
            entries={recentEntries}
            onEntryClick={handleEntryClick}
            onEntryDoubleClick={handleEntryDoubleClick}
          />
        </div>

        {/* Vault Status + Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <VaultStatusSection
            cloudSyncState={cloudSyncState}
            localBackupState={localBackupState}
            teamSyncState={teamSyncState}
            authMode={authMode}
            maxConnections={maxConnections}
            connectionCount={connectionCount}
            isTrialing={isTrialing}
            trialDaysRemaining={trialDaysRemaining}
          />
          <VaultOverviewSection
            typeCounts={typeCounts}
            credentialCount={credentialCount}
            documentCount={documentCount}
            folderCount={folders.length}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Welcome Bar ──────────────────────────────────────────────────────────── */

function WelcomeBar({
  displayName,
  entryCount,
  credentialCount,
  folderCount,
  onQuickConnect,
}: {
  displayName: string | null;
  entryCount: number;
  credentialCount: number;
  folderCount: number;
  onQuickConnect: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-semibold text-ink">
          Welcome back{displayName ? `, ${displayName}` : ""}
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          {entryCount} {entryCount === 1 ? "entry" : "entries"} &middot;{" "}
          {credentialCount} {credentialCount === 1 ? "credential" : "credentials"} &middot;{" "}
          {folderCount} {folderCount === 1 ? "folder" : "folders"}
        </p>
      </div>
      <button
        onClick={onQuickConnect}
        className="flex items-center gap-2 px-4 py-2 bg-conduit-600 hover:bg-conduit-500 text-white rounded-lg transition-colors text-sm font-medium"
      >
        Quick Connect
        <kbd className="ml-1 px-1.5 py-0.5 text-[11px] bg-white/20 rounded">
          {IS_MAC ? "⌘N" : "Ctrl+N"}
        </kbd>
      </button>
    </div>
  );
}

/* ── Search + Tag Filters ─────────────────────────────────────────────────── */

function SearchTagSection({
  tags,
  onSearchFocus,
  onTagClick,
}: {
  tags: string[];
  onSearchFocus: () => void;
  onTagClick: (tag: string) => void;
}) {
  const MAX_TAGS = 8;
  const visibleTags = tags.slice(0, MAX_TAGS);
  const hiddenCount = tags.length - MAX_TAGS;

  return (
    <div className="space-y-2">
      <button
        onClick={onSearchFocus}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-well border border-stroke rounded-lg text-left hover:border-stroke-dim transition-colors"
      >
        <SearchIcon size={16} className="text-ink-muted" />
        <span className="text-sm text-ink-faint">Search entries...</span>
      </button>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => (
            <button
              key={tag}
              onClick={() => onTagClick(tag)}
              className="px-2.5 py-1 text-xs bg-panel border border-stroke rounded-full text-ink-muted hover:text-ink hover:border-stroke-dim transition-colors"
            >
              {tag}
            </button>
          ))}
          {hiddenCount > 0 && (
            <span className="px-2.5 py-1 text-xs text-ink-faint">
              +{hiddenCount} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Entry Row (shared) ───────────────────────────────────────────────────── */

function EntryRow({
  entry,
  showTimestamp,
  onClick,
  onDoubleClick,
}: {
  entry: EntryMeta;
  showTimestamp?: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
  const colorResult = getEntryColor(entry.entry_type, entry.color);

  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md hover:bg-raised text-left transition-colors"
    >
      <Icon size={16} className={colorResult.className} style={colorResult.style} />
      <span className="text-sm text-ink truncate flex-1">{entry.name}</span>
      {showTimestamp ? (
        <span className="text-xs text-ink-faint flex-shrink-0">
          {formatRelativeTime(entry.updated_at)}
        </span>
      ) : (
        <span className="text-xs text-ink-faint flex-shrink-0 uppercase">
          {TYPE_LABELS[entry.entry_type] ?? entry.entry_type}
        </span>
      )}
    </button>
  );
}

/* ── Favorites ────────────────────────────────────────────────────────────── */

function FavoritesSection({
  entries,
  onEntryClick,
  onEntryDoubleClick,
}: {
  entries: EntryMeta[];
  onEntryClick: (id: string) => void;
  onEntryDoubleClick: (entry: EntryMeta) => void;
}) {
  return (
    <div className="bg-panel rounded-lg border border-stroke p-4">
      <h3 className="text-sm font-medium text-ink-muted mb-3">Favorites</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-ink-faint py-4 text-center">
          Star entries to add them here
        </p>
      ) : (
        <div className="space-y-0.5">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onClick={() => onEntryClick(entry.id)}
              onDoubleClick={() => onEntryDoubleClick(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Recently Modified ────────────────────────────────────────────────────── */

function RecentlyModifiedSection({
  entries,
  onEntryClick,
  onEntryDoubleClick,
}: {
  entries: EntryMeta[];
  onEntryClick: (id: string) => void;
  onEntryDoubleClick: (entry: EntryMeta) => void;
}) {
  return (
    <div className="bg-panel rounded-lg border border-stroke p-4">
      <h3 className="text-sm font-medium text-ink-muted mb-3">Recently Modified</h3>
      {entries.length === 0 ? (
        <p className="text-xs text-ink-faint py-4 text-center">
          No recent entries
        </p>
      ) : (
        <div className="space-y-0.5">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              showTimestamp
              onClick={() => onEntryClick(entry.id)}
              onDoubleClick={() => onEntryDoubleClick(entry)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Status Row (shared) ──────────────────────────────────────────────────── */

function StatusRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: "ok" | "error" | "syncing" | "idle" | "disabled";
  detail: string;
}) {
  const dotColor =
    status === "ok"
      ? "bg-green-400"
      : status === "error"
        ? "bg-red-400"
        : status === "syncing"
          ? "bg-yellow-400"
          : "bg-ink-faint";

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-xs text-ink">{label}</span>
      </div>
      <span className="text-xs text-ink-muted truncate ml-2">{detail}</span>
    </div>
  );
}

/* ── Vault Status ─────────────────────────────────────────────────────────── */

function VaultStatusSection({
  cloudSyncState,
  localBackupState,
  teamSyncState,
  authMode,
  maxConnections,
  connectionCount,
  isTrialing,
  trialDaysRemaining,
}: {
  cloudSyncState: CloudSyncState | null;
  localBackupState: LocalBackupState | null;
  teamSyncState: TeamSyncState | null;
  authMode: string | null;
  maxConnections: number;
  connectionCount: number;
  isTrialing: boolean;
  trialDaysRemaining: number;
}) {
  return (
    <div className="bg-panel rounded-lg border border-stroke p-4">
      <h3 className="text-sm font-medium text-ink-muted mb-3">Vault Status</h3>
      <div className="space-y-2.5">
        {/* Cloud Sync */}
        {authMode !== "local" && (
          <StatusRow
            label="Cloud Sync"
            status={
              !cloudSyncState?.enabled
                ? "disabled"
                : cloudSyncState.status === "error"
                  ? "error"
                  : cloudSyncState.status === "synced"
                    ? "ok"
                    : cloudSyncState.status === "syncing"
                      ? "syncing"
                      : "idle"
            }
            detail={
              !cloudSyncState?.enabled
                ? "Disabled"
                : cloudSyncState.status === "error"
                  ? cloudSyncState.error ?? "Error"
                  : cloudSyncState.status === "synced"
                    ? "Synced"
                    : cloudSyncState.status === "syncing"
                      ? "Syncing..."
                      : "Idle"
            }
          />
        )}

        {/* Local Backup */}
        <StatusRow
          label="Local Backup"
          status={
            !localBackupState?.enabled
              ? "disabled"
              : localBackupState.status === "error"
                ? "error"
                : localBackupState.status === "backed-up"
                  ? "ok"
                  : "idle"
          }
          detail={
            !localBackupState?.enabled
              ? "Disabled"
              : localBackupState.status === "error"
                ? localBackupState.error ?? "Error"
                : localBackupState.lastBackedUpAt
                  ? `Last: ${formatRelativeTime(localBackupState.lastBackedUpAt)}`
                  : "No backups yet"
          }
        />

        {/* Team Sync */}
        {authMode !== "local" && teamSyncState && (
          <StatusRow
            label="Team Sync"
            status={
              teamSyncState.status === "error"
                ? "error"
                : teamSyncState.status === "synced"
                  ? "ok"
                  : teamSyncState.status === "syncing"
                    ? "syncing"
                    : "idle"
            }
            detail={
              teamSyncState.status === "error"
                ? teamSyncState.error ?? "Error"
                : teamSyncState.pendingChanges > 0
                  ? `${teamSyncState.pendingChanges} pending`
                  : teamSyncState.status === "synced"
                    ? "Synced"
                    : "Idle"
            }
          />
        )}

        {/* Plan Usage */}
        {maxConnections > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-ink-muted">Plan Usage</span>
              <span className="text-xs text-ink-muted">
                {connectionCount}/{maxConnections}
              </span>
            </div>
            <div className="h-1.5 bg-well rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  connectionCount >= maxConnections
                    ? "bg-red-400"
                    : connectionCount > maxConnections * 0.8
                      ? "bg-yellow-400"
                      : "bg-conduit-500"
                }`}
                style={{
                  width: `${Math.min(100, (connectionCount / maxConnections) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* Trial Info */}
        {isTrialing && trialDaysRemaining >= 0 && (
          <div className="flex items-center justify-between pt-1 border-t border-stroke-dim">
            <span className="text-xs text-ink-muted">Trial</span>
            <span
              className={`text-xs font-medium ${
                trialDaysRemaining <= 3
                  ? "text-red-400"
                  : trialDaysRemaining <= 7
                    ? "text-yellow-400"
                    : "text-conduit-400"
              }`}
            >
              {trialDaysRemaining} {trialDaysRemaining === 1 ? "day" : "days"} remaining
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Vault Overview ───────────────────────────────────────────────────────── */

function VaultOverviewSection({
  typeCounts,
  credentialCount,
  documentCount,
  folderCount,
}: {
  typeCounts: Record<string, number>;
  credentialCount: number;
  documentCount: number;
  folderCount: number;
}) {
  return (
    <div className="bg-panel rounded-lg border border-stroke p-4">
      <h3 className="text-sm font-medium text-ink-muted mb-3">Overview</h3>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {CONNECTION_TYPES.map((type) => {
          const Icon = getEntryIcon(type);
          const colorResult = getEntryColor(type);
          return (
            <div key={type} className="flex items-center gap-2.5 p-2.5 bg-well rounded-md">
              <Icon size={18} className={colorResult.className} style={colorResult.style} />
              <div>
                <p className="text-lg font-semibold text-ink leading-none">
                  {typeCounts[type] || 0}
                </p>
                <p className="text-[11px] text-ink-faint">{TYPE_LABELS[type]}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 text-xs text-ink-faint">
        <span>
          {credentialCount} {credentialCount === 1 ? "credential" : "credentials"}
        </span>
        <span>
          {documentCount} {documentCount === 1 ? "document" : "documents"}
        </span>
        <span>
          {folderCount} {folderCount === 1 ? "folder" : "folders"}
        </span>
      </div>
    </div>
  );
}
