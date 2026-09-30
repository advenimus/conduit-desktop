import type { EntryMeta, EntryType, FolderData } from "../../../types/entry";
import type { ReachabilityResult } from "../../../types/dashboard";
import { STATUS_RANK, UNCHECKED_RANK } from "../reachability/reachabilityCopy";
import { isCheckable } from "../reachability/reachabilityTarget";

export type FolderSort = "name" | "type" | "last-connected" | "status";

export const FOLDER_SORT_OPTIONS: readonly { readonly value: FolderSort; readonly label: string }[] = [
  { value: "name", label: "Name" },
  { value: "type", label: "Type" },
  { value: "last-connected", label: "Last connected" },
  { value: "status", label: "Status" },
];

export const ENTRY_TYPE_LABELS: Readonly<Record<EntryType, string>> = {
  ssh: "SSH",
  rdp: "RDP",
  vnc: "VNC",
  web: "Web",
  command: "Command",
  document: "Document",
  credential: "Credential",
};

const CONNECTION_TYPES: ReadonlySet<EntryType> = new Set(["ssh", "rdp", "vnc", "web"]);

export interface FolderListItem {
  readonly entry: EntryMeta;
  /** Sub-folder names from the viewed folder down to the entry's folder; empty for direct children. */
  readonly subPath: readonly string[];
}

/** Every entry in the folder and all its sub-folders, with the path of the sub-folder each sits in. */
export function collectFolderItems(folderId: string, entries: readonly EntryMeta[], folders: readonly FolderData[]): FolderListItem[] {
  const paths = new Map<string, readonly string[]>([[folderId, []]]);
  const walk = (parentId: string, path: readonly string[]) => {
    for (const f of folders) {
      if (f.parent_id !== parentId || paths.has(f.id)) continue;
      const childPath = [...path, f.name];
      paths.set(f.id, childPath);
      walk(f.id, childPath);
    }
  };
  walk(folderId, []);
  return entries.flatMap((entry) => {
    const subPath = entry.folder_id ? paths.get(entry.folder_id) : undefined;
    return subPath ? [{ entry, subPath }] : [];
  });
}

/** Case-insensitive match on name, host and tags. */
export function filterFolderItems(items: readonly FolderListItem[], query: string): FolderListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(({ entry }) =>
    entry.name.toLowerCase().includes(q) ||
    (entry.host ?? "").toLowerCase().includes(q) ||
    entry.tags.some((tag) => tag.toLowerCase().includes(q)),
  );
}

export interface SortContext {
  /** Entry id to ISO time of its last connection. */
  readonly lastConnected: ReadonlyMap<string, string>;
  readonly results: Readonly<Record<string, ReachabilityResult>>;
}

const byName = (a: FolderListItem, b: FolderListItem) => a.entry.name.localeCompare(b.entry.name);

function compareLastConnected(ctx: SortContext, a: FolderListItem, b: FolderListItem): number {
  const ta = ctx.lastConnected.get(a.entry.id);
  const tb = ctx.lastConnected.get(b.entry.id);
  if (ta && tb) return Date.parse(tb) - Date.parse(ta);
  if (ta) return -1;
  if (tb) return 1;
  return 0;
}

function statusRank(ctx: SortContext, item: FolderListItem): number {
  const result = ctx.results[item.entry.id];
  return result ? STATUS_RANK[result.status] : UNCHECKED_RANK;
}

export function sortFolderItems(items: readonly FolderListItem[], sort: FolderSort, ctx: SortContext): FolderListItem[] {
  const compare = (a: FolderListItem, b: FolderListItem): number => {
    switch (sort) {
      case "name":
        return 0;
      case "type":
        return ENTRY_TYPE_LABELS[a.entry.entry_type].localeCompare(ENTRY_TYPE_LABELS[b.entry.entry_type]);
      case "last-connected":
        return compareLastConnected(ctx, a, b);
      case "status":
        return statusRank(ctx, a) - statusRank(ctx, b);
    }
  };
  return [...items].sort((a, b) => compare(a, b) || byName(a, b));
}

/** "{host} · in {Sub / Path}", either part alone, or null. */
export function rowDescription({ entry, subPath }: FolderListItem): string | null {
  const host = CONNECTION_TYPES.has(entry.entry_type) && entry.host ? entry.host : null;
  const where = subPath.length > 0 ? `in ${subPath.join(" / ")}` : null;
  if (host && where) return `${host} · ${where}`;
  return host ?? where;
}

/** Open all: connection entries (ssh, rdp, vnc, web) that are not locked, in list order. */
export function openAllIds(items: readonly FolderListItem[], isLocked: (id: string) => boolean): string[] {
  return items.filter(({ entry }) => CONNECTION_TYPES.has(entry.entry_type) && !isLocked(entry.id)).map(({ entry }) => entry.id);
}

/** Check all: checkable entries in list order; `capped` when the list had more than `limit`. */
export function checkAllIds(items: readonly FolderListItem[], limit: number): { ids: string[]; capped: boolean } {
  const all = items.filter(({ entry }) => isCheckable(entry)).map(({ entry }) => entry.id);
  return { ids: all.slice(0, limit), capped: all.length > limit };
}
