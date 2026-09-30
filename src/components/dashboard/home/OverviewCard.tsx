import { useMemo } from "react";
import type { EntryMeta } from "../../../types/entry";
import { getEntryColor, getEntryIcon } from "../../entries/entryIcons";
import { Card, SectionHeader } from "../../ui";
import { TYPE_LABELS } from "./entryDisplay";

const TILE_TYPES = ["ssh", "rdp", "vnc", "web", "command"] as const;

/** The Overview card beside Vault Status: a tile per connection type, then the other counts. */
export default function OverviewCard({
  entries,
  credentialCount,
  folderCount,
}: {
  entries: readonly EntryMeta[];
  credentialCount: number;
  folderCount: number;
}) {
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries) counts[e.entry_type] = (counts[e.entry_type] ?? 0) + 1;
    return counts;
  }, [entries]);
  const documentCount = typeCounts.document ?? 0;

  return (
    <Card>
      <SectionHeader title="Overview" />
      <div className="grid grid-cols-3 gap-2 mb-3">
        {TILE_TYPES.map((type) => {
          const Icon = getEntryIcon(type);
          const colorResult = getEntryColor(type);
          return (
            <div key={type} className="flex items-center gap-2.5 p-2.5 bg-editor border border-card-border rounded-md">
              <Icon size={18} className={colorResult.className} style={colorResult.style} />
              <div className="min-w-0">
                <p className="text-title font-semibold text-ink leading-none">{typeCounts[type] ?? 0}</p>
                <p className="text-meta text-ink-faint truncate">{TYPE_LABELS[type]}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-ink-faint">
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
