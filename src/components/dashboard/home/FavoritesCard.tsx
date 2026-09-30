import { useMemo } from "react";
import { useEntryStore } from "../../../stores/entryStore";
import { Card, ListRow, SectionHeader } from "../../ui";
import { EntryIcon, EntryRowActions, openHomeEntry, typeLabel } from "./entryDisplay";
import { selectEntries } from "./storeSelectors";

/** Favorites (docs/DASHBOARD.md 4.5): a click opens, like Recently connected; hidden without favorites. */
export default function FavoritesCard() {
  const entries = useEntryStore(selectEntries);
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
            onClick={() => openHomeEntry(entry)}
            trailingOverlay
            trailing={<EntryRowActions entryId={entry.id} />}
          >
            {entry.name}
          </ListRow>
        ))}
      </div>
    </Card>
  );
}
