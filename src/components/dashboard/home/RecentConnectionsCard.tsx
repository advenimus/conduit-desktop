import { useEffect, useMemo, useState } from "react";
import { HOME_RECENT_LIMIT, type RecentConnection } from "../../../types/dashboard";
import { dashboardApi } from "../../../lib/dashboardApi";
import { openDashboardForEntry } from "../../../lib/openDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import type { EntryMeta } from "../../../types/entry";
import { Badge, Card, IconButton, ListRow, SectionHeader } from "../../ui";
import { formatRelativeTime } from "../relativeTime";
import { copyPassword } from "./copyPassword";
import { EntryIcon, openHomeEntry } from "./entryDisplay";
import { useSessionIdsKey } from "./useDebounced";
import { selectEntries } from "./storeSelectors";

const SESSION_CHANGE_DEBOUNCE_MS = 750;

function RecentMeta({ item }: { item: RecentConnection }) {
  if (item.lastOutcome === "open") return <>Now</>;
  return (
    <>
      {item.lastOutcome === "failed" && <Badge tone="danger">Failed</Badge>}
      {formatRelativeTime(item.lastStartedAt)}
    </>
  );
}

/** Recently connected (docs/DASHBOARD.md 4.3). `refreshKey` changes after Clear connection history. */
export default function RecentConnectionsCard({ refreshKey }: { refreshKey: number }) {
  const entries = useEntryStore(selectEntries);
  const sessionsKey = useSessionIdsKey(SESSION_CHANGE_DEBOUNCE_MS);
  const [items, setItems] = useState<readonly RecentConnection[] | null>(null);

  useEffect(() => {
    let alive = true;
    dashboardApi
      .historyRecent({ limit: HOME_RECENT_LIMIT })
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch((err) => {
        console.warn("[home] connection_history_recent failed:", err);
        if (alive) setItems(null);
      });
    return () => {
      alive = false;
    };
  }, [sessionsKey, refreshKey]);

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
      trailing={
        <>
          <IconButton size="sm" icon="key" label="Copy password" onClick={() => void copyPassword(entry.id)} />
          <IconButton size="sm" icon="infoCircle" label="View info" onClick={() => openDashboardForEntry(entry.id)} />
        </>
      }
    >
      {entry.name}
    </ListRow>
  );
}
