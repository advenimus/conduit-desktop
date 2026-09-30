import type { AiActivityItem, AiActivityOutcome } from "../../../types/dashboard";
import type { BadgeTone } from "../../ui";

/** "terminal_execute" becomes "Terminal execute". */
export function toolLabel(tool: string): string {
  const words = tool.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const OUTCOME_BADGES: Readonly<Record<Exclude<AiActivityOutcome, "success">, { text: string; tone: BadgeTone }>> = {
  error: { text: "Failed", tone: "danger" },
  rate_limited: { text: "Rate limited", tone: "warning" },
  access_denied: { text: "Denied", tone: "danger" },
};

export function outcomeBadge(outcome: AiActivityOutcome): { text: string; tone: BadgeTone } | null {
  return outcome === "success" ? null : OUTCOME_BADGES[outcome];
}

/** The entry name for entryId, else the session title for sessionId, else null. */
export function activityTarget(
  item: Pick<AiActivityItem, "entryId" | "sessionId">,
  entryNames: ReadonlyMap<string, string>,
  sessionTitles: ReadonlyMap<string, string>,
): string | null {
  if (item.entryId && entryNames.has(item.entryId)) return entryNames.get(item.entryId)!;
  if (item.sessionId && sessionTitles.has(item.sessionId)) return sessionTitles.get(item.sessionId)!;
  return null;
}
