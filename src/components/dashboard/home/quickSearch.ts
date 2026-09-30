import type { EntryMeta, FolderData } from "../../../types/entry";

export type QuickResult =
  | { readonly kind: "entry"; readonly id: string; readonly name: string; readonly entry: EntryMeta }
  | { readonly kind: "folder"; readonly id: string; readonly name: string; readonly folder: FolderData };

// Lower ranks first: name starts with the query, then name contains it, then host or tag contains it.
function nameRank(name: string, q: string): number | null {
  const lower = name.toLowerCase();
  if (lower.startsWith(q)) return 0;
  if (lower.includes(q)) return 1;
  return null;
}

function entryRank(entry: EntryMeta, q: string): number | null {
  const byName = nameRank(entry.name, q);
  if (byName !== null) return byName;
  if (entry.host?.toLowerCase().includes(q)) return 2;
  if (entry.tags.some((t) => t.toLowerCase().includes(q))) return 2;
  return null;
}

/** Home quick bar search (docs/DASHBOARD.md 4.2): entries by name, host and tags, folders by name. */
export function searchQuick(
  query: string,
  entries: readonly EntryMeta[],
  folders: readonly FolderData[],
  limit: number,
): QuickResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: { rank: number; result: QuickResult }[] = [];
  for (const entry of entries) {
    const rank = entryRank(entry, q);
    if (rank !== null) ranked.push({ rank, result: { kind: "entry", id: entry.id, name: entry.name, entry } });
  }
  for (const folder of folders) {
    const rank = nameRank(folder.name, q);
    if (rank !== null) ranked.push({ rank, result: { kind: "folder", id: folder.id, name: folder.name, folder } });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.result.name.localeCompare(b.result.name))
    .slice(0, limit)
    .map((r) => r.result);
}
