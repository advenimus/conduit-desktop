import type { Session } from "../stores/sessionStore";
import type { EntryType } from "../types/entry";

/** Types whose sessions get their own ids, so one entry can run several; the rest use the entry id as the session id. */
const MULTI_SESSION_TYPES: ReadonlySet<EntryType> = new Set(["ssh", "web"]);

export function canOpenAnotherSession(type: EntryType): boolean {
  return MULTI_SESSION_TYPES.has(type);
}

/** The entry's open tab, a live one first. Info tabs are views, and agent sessions carry no entry id. */
export function sessionForEntry(sessions: readonly Session[], entryId: string): Session | undefined {
  const own = sessions.filter((s) => s.entryId === entryId && s.type !== "dashboard");
  return own.find((s) => s.status !== "disconnected") ?? own[0];
}

export type DoubleClickAction = "open" | "edit" | "info";

/** Credentials (RD Gateways too) have nothing to connect to, so a double-click edits them; everything else opens. */
export function doubleClickAction(
  entry: { entry_type: EntryType; credential_type?: string | null },
  { canEdit }: { canEdit: boolean },
): DoubleClickAction {
  if (entry.entry_type !== "credential") return "open";
  return canEdit ? "edit" : "info";
}
