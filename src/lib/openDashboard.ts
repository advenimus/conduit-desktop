import { useSessionStore } from "../stores/sessionStore";
import { useEntryStore } from "../stores/entryStore";
import { KNOWLEDGE_SESSION_ID, KNOWLEDGE_TITLE, entryInfoSessionId, folderViewSessionId } from "./dashboardSessions";
import { focusSession } from "./focusSession";

export function openDashboardForEntry(entryId: string): void {
  const { sessions, addSession } = useSessionStore.getState();
  const entry = useEntryStore.getState().entries.find((e) => e.id === entryId);
  if (!entry) return;

  const dashboardSessionId = entryInfoSessionId(entryId);
  if (sessions.some((s) => s.id === dashboardSessionId)) {
    focusSession(dashboardSessionId);
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

/** Opens the folder view tab (docs/DASHBOARD.md, Folder view), or focuses it when it is open. */
export function openFolderView(folderId: string): void {
  const { sessions, addSession } = useSessionStore.getState();
  const folder = useEntryStore.getState().folders.find((f) => f.id === folderId);
  if (!folder) return;

  const sessionId = folderViewSessionId(folderId);
  if (sessions.some((s) => s.id === sessionId)) {
    focusSession(sessionId);
    return;
  }

  addSession({
    id: sessionId,
    type: "dashboard",
    title: folder.name,
    status: "connected",
    metadata: { folderId },
  });
}

/** Opens the vault Knowledge view, or focuses it when it is open. */
export function openKnowledgeView(): void {
  const { sessions, addSession } = useSessionStore.getState();
  if (sessions.some((s) => s.id === KNOWLEDGE_SESSION_ID)) {
    focusSession(KNOWLEDGE_SESSION_ID);
    return;
  }
  addSession({ id: KNOWLEDGE_SESSION_ID, type: "dashboard", title: KNOWLEDGE_TITLE, status: "connected" });
}
