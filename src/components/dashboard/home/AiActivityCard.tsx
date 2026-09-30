import { useMemo } from "react";
import { openDashboardForEntry } from "../../../lib/openDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { Badge, Card, ListRow, SectionHeader } from "../../ui";
import { formatRelativeTime } from "../relativeTime";
import { activityTarget, outcomeBadge, toolLabel } from "./aiActivityLabels";
import { EntryIcon } from "./entryDisplay";
import { useAiActivityFeed } from "./homeFeeds";
import { selectEntries, selectSessions } from "./storeSelectors";

/** AI activity (docs/DASHBOARD.md 4.7). Polls only while `active` (the Home view is its pane's active tab). */
export default function AiActivityCard({ className, active = true }: { className?: string; active?: boolean }) {
  const items = useAiActivityFeed(active);
  const entries = useEntryStore(selectEntries);
  const sessions = useSessionStore(selectSessions);
  const entriesById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const entryNames = useMemo(() => new Map(entries.map((e) => [e.id, e.name])), [entries]);
  const sessionTitles = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions]);

  if (!items || items.length === 0) return null;
  return (
    <Card className={className}>
      <SectionHeader title="AI activity" description="Recent tool calls from AI agents on this device" />
      <div className="space-y-px">
        {items.map((item, index) => {
          const target = activityTarget(item, entryNames, sessionTitles);
          const badge = outcomeBadge(item.outcome);
          const entry = item.entryId ? entriesById.get(item.entryId) : undefined;
          return (
            <ListRow
              key={`${item.at}-${index}`}
              leading={entry ? <EntryIcon entry={entry} /> : "sparkles"}
              meta={
                <>
                  {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
                  {formatRelativeTime(item.at)}
                </>
              }
              onClick={entry ? () => openDashboardForEntry(entry.id) : undefined}
            >
              {toolLabel(item.tool)}
              {target ? ` · ${target}` : ""}
            </ListRow>
          );
        })}
      </div>
    </Card>
  );
}
