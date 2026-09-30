import { useMemo } from "react";
import type { RecentConnection } from "../../../types/dashboard";
import { useEntryStore } from "../../../stores/entryStore";
import type { EntryMeta } from "../../../types/entry";
import { Badge, Card, ListRow, SectionHeader } from "../../ui";
import { formatRelativeTime } from "../relativeTime";
import { EntryIcon, EntryRowActions, openHomeEntry } from "./entryDisplay";
import { useRecentConnectionsFeed } from "./homeFeeds";
import { selectEntries } from "./storeSelectors";

function RecentMeta({ item }: { item: RecentConnection }) {
  if (item.lastOutcome === "open") return <>Open</>;
  return (
    <>
      {item.lastOutcome === "failed" && <Badge tone="danger">Failed</Badge>}
      {formatRelativeTime(item.lastStartedAt)}
    </>
  );
}

/** Recently connected (docs/DASHBOARD.md 4.3). Loads only while `active` (the Home view is its pane's active tab). */
export default function RecentConnectionsCard({ active = true }: { active?: boolean }) {
  const entries = useEntryStore(selectEntries);
  const items = useRecentConnectionsFeed(active);

  const rows = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return (items ?? []).flatMap((item) => {
      const entry = byId.get(item.entryId);
      return entry ? [{ item, entry }] : [];
    });
  }, [items, entries]);

  if (rows.length === 0) return null;
  return (
    <Card>
      <SectionHeader title="Recently connected" />
      <div className="space-y-px">
        {rows.map(({ item, entry }) => (
          <RecentRow key={item.entryId} item={item} entry={entry} />
        ))}
      </div>
    </Card>
  );
}

function RecentRow({ item, entry }: { item: RecentConnection; entry: EntryMeta }) {
  return (
    <ListRow
      leading={<EntryIcon entry={entry} />}
      meta={<RecentMeta item={item} />}
      onClick={() => openHomeEntry(entry)}
      trailingOverlay
      trailing={<EntryRowActions entryId={entry.id} />}
    >
      {entry.name}
    </ListRow>
  );
}
