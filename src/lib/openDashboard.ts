import { useSessionStore } from "../stores/sessionStore";
import { useEntryStore } from "../stores/entryStore";

export function openDashboardForEntry(entryId: string): void {
  const { sessions, setActiveSession, addSession } = useSessionStore.getState();
  const entry = useEntryStore.getState().entries.find((e) => e.id === entryId);
  if (!entry) return;

  const dashboardSessionId = `dashboard::${entryId}`;
  const existing = sessions.find((s) => s.id === dashboardSessionId);
  if (existing) {
    setActiveSession(dashboardSessionId);
    return;
  }

  addSession({
    id: dashboardSessionId,
    type: "dashboard",
    title: `${entry.name} (Info)`,
    status: "connected",
    entryId,
  });
}
