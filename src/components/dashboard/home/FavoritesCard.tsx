import { useMemo } from "react";
import { useEntryStore } from "../../../stores/entryStore";
import { Card, ListRow, SectionHeader } from "../../ui";
import { EntryIcon, typeLabel } from "./entryDisplay";

/** Favorites (docs/DASHBOARD.md 4.5): click selects, double-click opens; hidden without favorites. */
export default function FavoritesCard() {
  const entries = useEntryStore((s) => s.entries);
  const favorites = useMemo(() => entries.filter((e) => e.is_favorite), [entries]);
  if (favorites.length === 0) return null;
  return (
    <Card>
      <SectionHeader title="Favorites" />
      <div className="space-y-px">
        {favorites.map((entry) => (
          <ListRow
            key={entry.id}
            leading={<EntryIcon entry={entry} />}
            meta={typeLabel(entry.entry_type)}
            onClick={() => useEntryStore.getState().setSelectedEntry(entry.id)}
            onDoubleClick={() => {
              if (entry.entry_type !== "credential") void useEntryStore.getState().openEntry(entry.id);
            }}
          >
            {entry.name}
          </ListRow>
        ))}
      </div>
    </Card>
  );
}
