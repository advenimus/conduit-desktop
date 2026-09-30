import { useMemo, useState } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useTierStore } from "../../stores/tierStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import type { EntryType } from "../../types/entry";
import { Button, Card, IconButton, SearchInput, Select } from "../ui";
import CheckAllButton from "./folder/CheckAllButton";
import FolderEntryList from "./folder/FolderEntryList";
import OpenAllButton from "./folder/OpenAllButton";
import {
  FOLDER_SORT_OPTIONS,
  collectFolderItems,
  filterFolderItems,
  openAllIds,
  sortFolderItems,
  type FolderSort,
} from "./folder/folderList";
import { useLastConnected } from "./folder/useLastConnected";
import { useReachability } from "./reachability/useReachability";

interface FolderDashboardProps {
  folderId: string;
}

const TYPE_LABELS: Record<EntryType, string> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  credential: "Credentials",
  document: "Documents",
  command: "Commands",
};

const SORT_SELECT_ID = "folder-view-sort";

const newEntryIn = (folderId: string) =>
  document.dispatchEvent(new CustomEvent("conduit:new-entry", { detail: { folderId } }));

export default function FolderDashboard({ folderId }: FolderDashboardProps) {
  const entries = useEntryStore((s) => s.entries);
  const folders = useEntryStore((s) => s.folders);
  const lockedEntryIds = useTierStore((s) => s.lockedEntryIds);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FolderSort>("name");
  const reachability = useReachability();
  const lastConnected = useLastConnected(folderId);

  const folder = folders.find((f) => f.id === folderId);

  const allItems = useMemo(() => collectFolderItems(folderId, entries, folders), [entries, folders, folderId]);

  const subFolderCount = useMemo(
    () => folders.filter((f) => f.parent_id === folderId).length,
    [folders, folderId],
  );

  const typeCounts = useMemo(() => {
    const counts: Partial<Record<EntryType, number>> = {};
    for (const { entry } of allItems) {
      counts[entry.entry_type] = (counts[entry.entry_type] ?? 0) + 1;
    }
    return counts;
  }, [allItems]);

  const listed = useMemo(
    () => sortFolderItems(filterFolderItems(allItems, query), sort, { lastConnected, results: reachability.results }),
    [allItems, query, sort, lastConnected, reachability.results],
  );

  if (!folder) {
    return (
      <div className="flex-1 flex items-center justify-center bg-editor">
        <p className="text-body text-ink-faint">Folder not found</p>
      </div>
    );
  }

  const total = allItems.length;
  const typeEntries = Object.entries(typeCounts) as [EntryType, number][];
  const FolderIcon = getEntryIcon("folder", true, folder.icon);
  const folderColor = getEntryColor("folder", folder.color);

  return (
    <div className="flex-1 flex flex-col bg-editor overflow-y-auto h-full" data-cv-folder-view={folderId}>
      {/* Header */}
      <div className="p-6 border-b border-divider">
        <div className="flex items-center gap-3">
          <FolderIcon size={28} stroke={1.5} className={folderColor.className} style={folderColor.style} />
          <div className="flex-1 min-w-0">
            <h2 className="text-title font-semibold text-ink truncate">{folder.name}</h2>
            <p className="text-body text-ink-muted">
              {total} {total === 1 ? "entry" : "entries"}
              {subFolderCount > 0 && ` · ${subFolderCount} sub-folder${subFolderCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CheckAllButton items={listed} checkMany={reachability.checkMany} />
            <OpenAllButton entryIds={openAllIds(listed, (id) => lockedEntryIds.has(id))} />
            <IconButton icon="plus" label="New Entry" onClick={() => newEntryIn(folderId)} />
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
              <Card key={type} className="flex items-center gap-3">
                <Icon size={18} stroke={1.5} className={colorResult.className} style={colorResult.style} />
                <div>
                  <p className="text-title font-semibold text-ink">{count}</p>
                  <p className="text-label text-ink-muted">{TYPE_LABELS[type]}</p>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {total > 0 && (
        <section className="px-6 pt-4 pb-6">
          <div className="mb-3 flex items-center gap-3">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search this folder..."
              aria-label="Search this folder"
              wrapperClassName="max-w-sm"
            />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <label htmlFor={SORT_SELECT_ID} className="whitespace-nowrap text-label text-ink-muted">
                Sort by
              </label>
              <Select
                id={SORT_SELECT_ID}
                value={sort}
                onChange={(e) => setSort(e.target.value as FolderSort)}
                wrapperClassName="w-40"
              >
                {FOLDER_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <FolderEntryList items={listed} lastConnected={lastConnected} reachability={reachability} />
        </section>
      )}

      {/* Empty state */}
      {total === 0 && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-body text-ink-faint mb-2">This folder is empty</p>
            <Button variant="primary" onClick={() => newEntryIn(folderId)}>
              New Entry
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
