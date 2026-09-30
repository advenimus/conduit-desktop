import type { EntryType } from "../../types/entry";
import { getEntryColor, getEntryIcon } from "../entries/entryIcons";
import { cx } from "../ui";
import { TYPE_LABELS } from "./home/entryDisplay";

/** One order for the type tiles of Home Overview and the folder view. */
export const TYPE_TILE_ORDER: readonly EntryType[] = ["ssh", "rdp", "vnc", "web", "command", "document", "credential"];

/** A tile per type with a count above zero, in TYPE_TILE_ORDER; nothing when every count is zero. */
export default function TypeTiles({
  counts,
  types = TYPE_TILE_ORDER,
  className,
}: {
  counts: Readonly<Partial<Record<string, number>>>;
  types?: readonly EntryType[];
  className?: string;
}) {
  const shown = TYPE_TILE_ORDER.filter((type) => types.includes(type) && (counts[type] ?? 0) > 0);
  if (shown.length === 0) return null;
  return (
    <div className={cx("grid gap-2", className)} data-cv-type-tiles="">
      {shown.map((type) => {
        const Icon = getEntryIcon(type);
        const color = getEntryColor(type);
        return (
          <div key={type} className="flex items-center gap-2.5 rounded-md border border-card-border bg-editor p-2.5">
            <Icon size={18} className={color.className} style={color.style} />
            <div className="min-w-0">
              <p className="text-title font-semibold leading-none text-ink">{counts[type]}</p>
              <p className="truncate text-meta text-ink-faint">{TYPE_LABELS[type]}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function countByType(entries: readonly { entry_type: string }[]): Partial<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.entry_type] = (counts[e.entry_type] ?? 0) + 1;
  return counts;
}
