import type { SessionType } from "../stores/sessionStore";

export interface SessionStatusEvent {
  status: string;
  error: string | null;
  /** The remote side ended the session on purpose: an SSH shell exited, or an RDP user signed out. */
  ended?: boolean;
}

/** Whether a status event closes the tab: a session ended on purpose, or a local shell that exited cleanly. */
export function closesTab(type: SessionType, event: SessionStatusEvent): boolean {
  if (event.status !== "disconnected" || event.error) return false;
  return event.ended === true || type === "local_shell";
}
