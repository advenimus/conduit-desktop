import { useEntryStore } from "../../../stores/entryStore";
import { openDashboardForEntry } from "../../../lib/openDashboard";
import { getEntryColor, getEntryIcon } from "../../entries/entryIcons";
import { Badge, IconButton, ListRow } from "../../ui";
import { formatRelativeTime } from "../relativeTime";
import { reachabilityText } from "../reachability/reachabilityCopy";
import { isCheckable } from "../reachability/reachabilityTarget";
import type { UseReachability } from "../reachability/useReachability";
import { rowDescription, type FolderListItem } from "./folderList";

interface FolderEntryListProps {
  items: readonly FolderListItem[];
  lastConnected: ReadonlyMap<string, string>;
  reachability: Pick<UseReachability, "results" | "checking" | "check">;
}

function openItem({ entry }: FolderListItem) {
  if (entry.entry_type === "credential") openDashboardForEntry(entry.id);
  else void useEntryStore.getState().openEntry(entry.id);
}

function FolderEntryRow({ item, lastConnected, reachability }: { item: FolderListItem } & Omit<FolderEntryListProps, "items">) {
  const { entry } = item;
  const Icon = getEntryIcon(entry.entry_type, false, entry.icon);
  const color = getEntryColor(entry.entry_type, entry.color);
  const result = reachability.results[entry.id];
  const last = lastConnected.get(entry.id);
  const badge = result ? reachabilityText(result) : null;
  const description = rowDescription(item);

  return (
    <ListRow
      data-cv-folder-row={entry.id}
      onClick={() => openItem(item)}
      leading={<Icon size={16} stroke={1.5} className={color.className} style={color.style} />}
      description={description ?? undefined}
      // One-line rows take the two-line inset so every icon lines up in the mixed list.
      className={description ? undefined : "gap-3! px-3!"}
      meta={
        <>
          {badge && (
            <Badge tone={badge.tone} title={badge.detail}>
              {badge.badge}
            </Badge>
          )}
          {/* A fixed-width time slot keeps the badges in one column. */}
          <span className="min-w-16 text-right">{last ? formatRelativeTime(last) : ""}</span>
        </>
      }
      trailing={
        <>
          {isCheckable(entry) && (
            <IconButton
              size="sm"
              icon="plug"
              label="Check if it is up"
              disabled={reachability.checking.has(entry.id)}
              onClick={() => void reachability.check(entry.id)}
            />
          )}
          {entry.entry_type !== "credential" && (
            <IconButton size="sm" icon="playerPlay" label="Open" onClick={() => openItem(item)} />
          )}
          <IconButton size="sm" icon="infoCircle" label="View info" onClick={() => openDashboardForEntry(entry.id)} />
        </>
      }
    >
      {entry.name}
    </ListRow>
  );
}

/** The folder view's recursive entry list (docs/DASHBOARD.md 5). */
export default function FolderEntryList({ items, lastConnected, reachability }: FolderEntryListProps) {
  if (items.length === 0) {
    return <p className="py-6 text-center text-label text-ink-faint">No entries match your search</p>;
  }
  return (
    <div className="space-y-px" data-cv-folder-list="">
      {items.map((item) => (
        <FolderEntryRow key={item.entry.id} item={item} lastConnected={lastConnected} reachability={reachability} />
      ))}
    </div>
  );
}
