import { useSessionStore } from "../stores/sessionStore";
import { closesTab, type SessionStatusEvent } from "./sessionEnd";

type StatusPayload = { sessionId: string } & SessionStatusEvent;

/** terminal:status: a finished shell closes its tab, anything else marks the tab disconnected. */
export function applyTerminalStatus(data: StatusPayload): void {
  const store = useSessionStore.getState();
  const session = store.sessions.find((s) => s.id === data.sessionId);
  if (!session) return;
  if (closesTab(session.type, data)) void store.closeSession(data.sessionId);
  else if (data.status === "disconnected") store.updateSessionStatus(data.sessionId, "disconnected", data.error);
}

/**
 * rdp:status: a sign-out closes the tab, even one in the background. A drop marks the tab disconnected, so it
 * shows the error and opening the entry again reconnects it; a reconnect's own disconnect is left alone.
 */
export function applyRdpStatus(data: StatusPayload): void {
  const store = useSessionStore.getState();
  const session = store.sessions.find((s) => s.id === data.sessionId);
  if (!session || session.metadata?.reconnecting) return;
  if (closesTab(session.type, data)) void store.closeSession(data.sessionId);
  else if (data.status === "disconnected") store.updateSessionStatus(data.sessionId, "disconnected", data.error || "Session disconnected");
}
