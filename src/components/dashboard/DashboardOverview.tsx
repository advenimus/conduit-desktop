import { useMemo } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useTierStore } from "../../stores/tierStore";
import { useAuthStore } from "../../stores/authStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import type { EntryMeta } from "../../types/entry";
import { SearchIcon } from "../../lib/icons";
import { Button, Card, Kbd, ListRow, SectionHeader } from "../ui";
import VaultStatusCard from "./VaultStatusCard";
import { formatRelativeTime } from "./relativeTime";

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

const TYPE_LABELS: Record<string, string> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  command: "Command",
};

const CONNECTION_TYPES = ["ssh", "rdp", "vnc", "web"] as const;

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
    <div className="flex-1 flex flex-col bg-editor overflow-y-auto h-full">
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
          <EntryListCard
            title="Favorites"
            emptyText="Star entries to add them here"
            entries={favoriteEntries}
            onEntryClick={handleEntryClick}
            onEntryDoubleClick={handleEntryDoubleClick}
          />
          <EntryListCard
            title="Recently Modified"
            emptyText="No recent entries"
            entries={recentEntries}
            showTimestamp
            onEntryClick={handleEntryClick}
            onEntryDoubleClick={handleEntryDoubleClick}
          />
        </div>

        {/* Vault Status + Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <VaultStatusCard
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
        <h1 className="text-title font-semibold text-ink">
          Welcome back{displayName ? `, ${displayName}` : ""}
        </h1>
        <p className="text-body text-ink-muted mt-1">
          {entryCount} {entryCount === 1 ? "entry" : "entries"} &middot;{" "}
          {credentialCount} {credentialCount === 1 ? "credential" : "credentials"} &middot;{" "}
          {folderCount} {folderCount === 1 ? "folder" : "folders"}
        </p>
      </div>
      <Button variant="primary" onClick={onQuickConnect} className="gap-2">
        Quick Connect
        <Kbd className="!border-white/40 !text-white">{IS_MAC ? "⌘N" : "Ctrl+N"}</Kbd>
      </Button>
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
        type="button"
        onClick={onSearchFocus}
        className="w-full flex items-center gap-1.5 h-control-lg px-2 bg-input border border-input-border rounded text-left hover:border-control transition-colors"
      >
        <SearchIcon size={16} className="text-ink-muted" />
        <span className="text-body text-(--c-input-placeholder)">Search entries...</span>
      </button>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {visibleTags.map((tag) => (
            <Button key={tag} size="sm" onClick={() => onTagClick(tag)}>
              {tag}
            </Button>
          ))}
          {hiddenCount > 0 && (
            <span className="inline-flex items-center h-control-sm px-1.5 text-meta text-ink-faint">
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
    <ListRow
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      leading={<Icon size={16} className={colorResult.className} style={colorResult.style} />}
      meta={showTimestamp ? formatRelativeTime(entry.updated_at) : (TYPE_LABELS[entry.entry_type] ?? entry.entry_type)}
    >
      {entry.name}
    </ListRow>
  );
}

/* ── Entry lists: Favorites and Recently Modified ─────────────────────────── */

function EntryListCard({
  title,
  emptyText,
  entries,
  showTimestamp,
  onEntryClick,
  onEntryDoubleClick,
}: {
  title: string;
  emptyText: string;
  entries: EntryMeta[];
  showTimestamp?: boolean;
  onEntryClick: (id: string) => void;
  onEntryDoubleClick: (entry: EntryMeta) => void;
}) {
  return (
    <Card>
      <SectionHeader title={title} />
      {entries.length === 0 ? (
        <p className="text-label text-ink-faint py-4 text-center">{emptyText}</p>
      ) : (
        <div className="space-y-px">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              showTimestamp={showTimestamp}
              onClick={() => onEntryClick(entry.id)}
              onDoubleClick={() => onEntryDoubleClick(entry)}
            />
          ))}
        </div>
      )}
    </Card>
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
    <Card>
      <SectionHeader title="Overview" />
      <div className="grid grid-cols-2 gap-2 mb-3">
        {CONNECTION_TYPES.map((type) => {
          const Icon = getEntryIcon(type);
          const colorResult = getEntryColor(type);
          return (
            <div key={type} className="flex items-center gap-2.5 p-2.5 bg-editor border border-card-border rounded-md">
              <Icon size={18} className={colorResult.className} style={colorResult.style} />
              <div>
                <p className="text-title font-semibold text-ink leading-none">
                  {typeCounts[type] || 0}
                </p>
                <p className="text-meta text-ink-faint">{TYPE_LABELS[type]}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 text-label text-ink-faint">
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
    </Card>
  );
}
