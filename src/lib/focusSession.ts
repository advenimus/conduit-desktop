import { getAllLeaves, useLayoutStore } from "../stores/layoutStore";

/** Focuses the pane that holds the session and makes it that pane's active tab. False when no pane holds it. */
export function focusSession(sessionId: string): boolean {
  const layout = useLayoutStore.getState();
  const pane = getAllLeaves(layout.root).find((leaf) => leaf.sessionIds.includes(sessionId));
  if (!pane) return false;
  layout.setFocusedPane(pane.id);
  layout.setActiveSessionInPane(pane.id, sessionId);
  return true;
}
