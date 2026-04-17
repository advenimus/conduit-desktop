import { useMemo } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import type { EntryMeta, EntryType } from "../../types/entry";

interface FolderDashboardProps {
  folderId: string;
}

const TYPE_COLORS: Record<EntryType, string> = {
  ssh: "bg-green-400",
  rdp: "bg-blue-400",
  vnc: "bg-purple-400",
  web: "bg-cyan-400",
  credential: "bg-yellow-400",
  document: "bg-teal-400",
  command: "bg-amber-400",
};

const TYPE_LABELS: Record<EntryType, string> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  credential: "Credentials",
  document: "Documents",
  command: "Commands",
};

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export default function FolderDashboard({ folderId }: FolderDashboardProps) {
  const { entries, folders, setSelectedEntry, openEntry } = useEntryStore();

  const folder = folders.find((f) => f.id === folderId);

  // Collect all entries recursively under this folder
  const folderEntries = useMemo(() => {
    const descendantFolderIds = new Set<string>();

    const collectFolders = (parentId: string) => {
      for (const f of folders) {
        if (f.parent_id === parentId && !descendantFolderIds.has(f.id)) {
          descendantFolderIds.add(f.id);
          collectFolders(f.id);
        }
      }
    };

    descendantFolderIds.add(folderId);
    collectFolders(folderId);

    return entries.filter((e) => e.folder_id && descendantFolderIds.has(e.folder_id));
  }, [entries, folders, folderId]);

  // Count sub-folders (direct children only)
  const subFolderCount = useMemo(
    () => folders.filter((f) => f.parent_id === folderId).length,
    [folders, folderId],
  );

  // Group by type
  const typeCounts = useMemo(() => {
    const counts: Partial<Record<EntryType, number>> = {};
    for (const e of folderEntries) {
      counts[e.entry_type] = (counts[e.entry_type] ?? 0) + 1;
    }
    return counts;
  }, [folderEntries]);

  // Recent entries by updated_at
  const recentEntries = useMemo(
    () =>
      [...folderEntries]
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
        .slice(0, 8),
    [folderEntries],
  );

  // Oldest entries by created_at (credential age)
  const oldestEntries = useMemo(
    () =>
      [...folderEntries]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .slice(0, 8),
    [folderEntries],
  );

  if (!folder) {
    return (
      <div className="flex-1 flex items-center justify-center bg-canvas">
        <p className="text-ink-faint">Folder not found</p>
      </div>
    );
  }

  const total = folderEntries.length;
  const typeEntries = Object.entries(typeCounts) as [EntryType, number][];

  return (
    <div className="flex-1 flex flex-col bg-canvas overflow-y-auto h-full">
      {/* Header */}
      <div className="p-6 border-b border-stroke">
        <div className="flex items-center gap-3">
          {(() => {
            const FolderIcon = getEntryIcon("folder", true, folder.icon);
            const folderColorResult = getEntryColor("folder", folder.color);
            return <FolderIcon size={28} stroke={1.5} className={folderColorResult.className} style={folderColorResult.style} />;
          })()}
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-semibold text-ink truncate">{folder.name}</h2>
            <p className="text-sm text-ink-muted">
              {total} {total === 1 ? "entry" : "entries"}
              {subFolderCount > 0 && ` \u00b7 ${subFolderCount} sub-folder${subFolderCount === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      {typeEntries.length > 0 && (
        <div className="p-6 pb-2 flex flex-wrap gap-3">
          {typeEntries.map(([type, count]) => {
            const Icon = getEntryIcon(type, false);
            const colorResult = getEntryColor(type);
            return (
              <div
                key={type}
                className="bg-panel rounded-lg px-4 py-3 border border-stroke flex items-center gap-3"
              >
                <Icon size={18} stroke={1.5} className={colorResult.className} style={colorResult.style} />
                <div>
                  <p className="text-lg font-semibold text-ink">{count}</p>
                  <p className="text-xs text-ink-muted">{TYPE_LABELS[type]}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Type distribution bar */}
      {total > 0 && typeEntries.length > 1 && (
        <div className="px-6 py-3">
          <p className="text-xs text-ink-faint mb-2">Type Distribution</p>
          <div className="flex h-2 rounded-full overflow-hidden gap-0.5">
            {typeEntries.map(([type, count]) => (
              <div
                key={type}
                className={`${TYPE_COLORS[type]} rounded-full`}
                style={{ flex: count }}
                title={`${TYPE_LABELS[type]}: ${count}`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-3 mt-2">
            {typeEntries.map(([type, count]) => (
              <div key={type} className="flex items-center gap-1.5 text-xs text-ink-muted">
                <span className={`inline-block w-2 h-2 rounded-full ${TYPE_COLORS[type]}`} />
                {TYPE_LABELS[type]} ({Math.round((count / total) * 100)}%)
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {recentEntries.length > 0 && (
        <div className="px-6 py-4">
          <h3 className="text-sm font-medium text-ink-muted mb-3">Recent Activity</h3>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            {recentEntries.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                subtitle={timeAgo(entry.updated_at)}
                onClick={() => setSelectedEntry(entry.id)}
                onDoubleClick={() => {
                  if (entry.entry_type !== "credential") openEntry(entry.id);
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Entry age */}
      {oldestEntries.length > 0 && (
        <div className="px-6 pb-6">
          <h3 className="text-sm font-medium text-ink-muted mb-3">Entry Age</h3>
          <div className="space-y-1">
            {oldestEntries.map((entry) => {
              const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
              const colorResult = getEntryColor(entry.entry_type, entry.color);
              return (
                <button
                  key={entry.id}
                  onClick={() => setSelectedEntry(entry.id)}
                  className="flex items-center gap-3 w-full px-3 py-2 rounded hover:bg-panel text-left transition-colors"
                >
                  <Icon size={16} stroke={1.5} className={colorResult.className} style={colorResult.style} />
                  <span className="text-sm text-ink truncate flex-1">{entry.name}</span>
                  <span className="text-xs text-ink-faint flex-shrink-0">
                    {timeAgo(entry.created_at)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {total === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-ink-faint mb-2">This folder is empty</p>
            <button
              onClick={() =>
                document.dispatchEvent(
                  new CustomEvent("conduit:new-entry", { detail: { folderId } }),
                )
              }
              className="px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded-md text-sm font-medium transition-colors"
            >
              New Entry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  subtitle,
  onClick,
  onDoubleClick,
}: {
  entry: EntryMeta;
  subtitle: string;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
  const colorResult = getEntryColor(entry.entry_type, entry.color);

  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className="flex items-center gap-3 p-3 bg-panel hover:bg-raised border border-stroke rounded-lg text-left transition-colors hover:border-stroke-dim"
    >
      <Icon size={20} stroke={1.5} className={colorResult.className} style={colorResult.style} />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink truncate">{entry.name}</p>
        <p className="text-xs text-ink-faint truncate">{subtitle}</p>
      </div>
    </button>
  );
}
