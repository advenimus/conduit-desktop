import { useMemo } from "react";
import type { EntryMeta } from "../../../types/entry";
import { Card, SectionHeader } from "../../ui";
import TypeTiles, { countByType } from "../TypeTiles";

const CONNECTION_TYPES = ["ssh", "rdp", "vnc", "web", "command"] as const;

/** The Overview card beside Vault status: a tile per connection type that has entries; hidden when there are none. */
export default function OverviewCard({ entries }: { entries: readonly EntryMeta[] }) {
  const counts = useMemo(() => countByType(entries), [entries]);
  if (!CONNECTION_TYPES.some((type) => (counts[type] ?? 0) > 0)) return null;
  return (
    <Card>
      <SectionHeader title="Overview" />
      <TypeTiles counts={counts} types={CONNECTION_TYPES} className="grid-cols-3" />
    </Card>
  );
}
