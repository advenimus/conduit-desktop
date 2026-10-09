import { useMemo, useState } from "react";
import { useEntryStore } from "../../stores/entryStore";
import { useTierStore } from "../../stores/tierStore";
import { getEntryIcon, getEntryColor } from "../entries/entryIcons";
import { Button, IconButton, SearchInput, Select } from "../ui";
import TypeTiles, { countByType } from "./TypeTiles";
import FolderKnowledgeSection from "../knowledge/FolderKnowledgeSection";
import CheckAllButton from "./folder/CheckAllButton";
import FolderEntryList from "./folder/FolderEntryList";
import OpenAllButton from "./folder/OpenAllButton";
import { CONTENT_WIDTH, splitGrid } from "./pageLayout";
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

  const typeCounts = useMemo(() => countByType(allItems.map((item) => item.entry)), [allItems]);

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
  const FolderIcon = getEntryIcon("folder", true, folder.icon);
  const folderColor = getEntryColor("folder", folder.color);

  return (
    <div className="@container flex-1 flex flex-col bg-editor overflow-y-auto h-full" data-cv-folder-view={folderId}>
      {/* Header */}
      <div className="py-6 border-b border-divider">
        <div className={`${CONTENT_WIDTH} flex items-center gap-3 px-6`}>
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

      <div className={CONTENT_WIDTH}>
        {/* Summary cards */}
        <TypeTiles counts={typeCounts} className="grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] px-6 pt-6 pb-2" />
        <div className={`${splitGrid(total > 0 ? "balanced" : null)} px-6 pb-6`}>
          {total > 0 && (
            <section className="min-w-0 pt-4">
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
          <FolderKnowledgeSection folderId={folderId} assetCount={total} className="mt-4 self-start" />
        </div>
      </div>

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
