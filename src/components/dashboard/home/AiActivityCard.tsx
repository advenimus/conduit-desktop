import { useEffect, useMemo, useState } from "react";
import { AI_ACTIVITY_POLL_MS, HOME_AI_ACTIVITY_LIMIT, type AiActivityItem } from "../../../types/dashboard";
import { dashboardApi } from "../../../lib/dashboardApi";
import { openDashboardForEntry } from "../../../lib/openDashboard";
import { useEntryStore } from "../../../stores/entryStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { Badge, Card, ListRow, SectionHeader } from "../../ui";
import { formatRelativeTime } from "../relativeTime";
import { activityTarget, outcomeBadge, toolLabel } from "./aiActivityLabels";

/** Loads on mount, then every AI_ACTIVITY_POLL_MS while the window is visible; null hides the card. */
function useAiActivity(): readonly AiActivityItem[] | null {
  const [items, setItems] = useState<readonly AiActivityItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      dashboardApi
        .aiActivity({ limit: HOME_AI_ACTIVITY_LIMIT })
        .then((res) => {
          if (alive) setItems(res.logFound ? res.items : null);
        })
        .catch((err) => {
          console.warn("[home] ai_activity_recent failed:", err);
          if (alive) setItems(null);
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, AI_ACTIVITY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return items;
}

/** AI activity (docs/DASHBOARD.md 4.7). */
export default function AiActivityCard({ className }: { className?: string }) {
  const items = useAiActivity();
  const entries = useEntryStore((s) => s.entries);
  const sessions = useSessionStore((s) => s.sessions);
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
          const entryId = item.entryId && entryNames.has(item.entryId) ? item.entryId : null;
          return (
            <ListRow
              key={`${item.at}-${index}`}
              leading="sparkles"
              meta={
                <>
                  {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
                  {formatRelativeTime(item.at)}
                </>
              }
              onClick={entryId ? () => openDashboardForEntry(entryId) : undefined}
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
