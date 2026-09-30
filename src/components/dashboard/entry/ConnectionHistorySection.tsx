import { useCallback, useState } from "react";
import { dashboardApi } from "../../../lib/dashboardApi";
import { DASHBOARD_CHANNELS, HISTORY_ENTRY_DEFAULT, type ConnectionHistoryEvent } from "../../../types/dashboard";
import { IconSlot, ListRow, SectionHeader } from "../../ui";
import { OUTCOME_LOOK, historyMeta } from "./historyFormat";
import { useSessionReload } from "./useSessionReload";

/** "Recent connections" on the entry info tab (docs/DASHBOARD.md 6.2). */
export default function ConnectionHistorySection({ entryId }: { entryId: string }) {
  const [events, setEvents] = useState<readonly ConnectionHistoryEvent[] | null>(null);

  const load = useCallback(() => {
    dashboardApi
      .historyForEntry({ entryId, limit: HISTORY_ENTRY_DEFAULT })
      .then(setEvents)
      .catch((err: unknown) => {
        console.warn(`${DASHBOARD_CHANNELS.historyForEntry} failed`, err);
        setEvents([]);
      });
  }, [entryId]);

  useSessionReload(load, entryId);

  return (
    <section className="mt-6" data-cv-entry-history="">
      <SectionHeader title="Recent connections" description="Connections from this device only." />
      {events !== null && events.length === 0 && (
        <p className="px-2 text-label text-ink-faint">No connections from this device yet.</p>
      )}
      {events !== null && events.length > 0 && (
        <div className="space-y-px">
          {events.map((event) => {
            const look = OUTCOME_LOOK[event.outcome];
            return (
              <ListRow key={event.id} leading={<IconSlot icon={look.icon} className={look.className} />} meta={historyMeta(event)}>
                {look.label}
              </ListRow>
            );
          })}
        </div>
      )}
    </section>
  );
}
