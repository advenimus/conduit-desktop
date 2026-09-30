import type { SemanticIconName } from "../../../lib/icons";
import type { ConnectionHistoryEvent, HistoryOutcome } from "../../../types/dashboard";

export interface OutcomeLook {
  readonly label: string;
  readonly icon: SemanticIconName;
  readonly className: string;
}

/** Icon, color and label of a history row by outcome (docs/DASHBOARD.md 8.2). */
export const OUTCOME_LOOK: Readonly<Record<HistoryOutcome, OutcomeLook>> = {
  open: { label: "Connected now", icon: "circleFilled", className: "text-(--c-state-connected)" },
  closed: { label: "Connected", icon: "circleCheck", className: "text-(--c-state-connected)" },
  dropped: { label: "Disconnected with an error", icon: "alertTriangle", className: "text-warning" },
  failed: { label: "Could not connect", icon: "circleX", className: "text-danger" },
  interrupted: { label: "Ended when Conduit closed", icon: "clock", className: "text-ink-faint" },
};

/** "{s} s" under a minute, "{m} min" under an hour, else "{h} h {m} min". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function formatStartedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "Sep 29, 2:14 PM · 1 h 5 min", the duration only when known and the session connected (a failed row's time is the attempt). */
export function historyMeta(event: Pick<ConnectionHistoryEvent, "startedAt" | "durationMs" | "outcome">): string {
  const when = formatStartedAt(event.startedAt);
  return event.durationMs === null || event.outcome === "failed" ? when : `${when} · ${formatDuration(event.durationMs)}`;
}
