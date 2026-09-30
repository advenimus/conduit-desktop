import { useVaultStore } from "../stores/vaultStore";
import { useSessionStore } from "../stores/sessionStore";
import { getAllLeaves, useLayoutStore } from "../stores/layoutStore";
import { useSidebarStore } from "../stores/sidebarStore";
import { HOME_SESSION_ID, HOME_TITLE } from "./dashboardSessions";
import { focusSession } from "./focusSession";

function hasHomeTab(): boolean {
  return useSessionStore.getState().sessions.some((s) => s.id === HOME_SESSION_ID);
}

/** Puts the pinned Home tab first in the first pane when a vault is unlocked and it is missing. */
export function ensureHomeTab(): void {
  if (!useVaultStore.getState().isUnlocked || hasHomeTab()) return;

  const layout = useLayoutStore.getState();
  const firstPane = getAllLeaves(layout.root)[0];
  layout.setFocusedPane(firstPane.id);
  useSessionStore.getState().addSession({
    id: HOME_SESSION_ID,
    type: "dashboard",
    title: HOME_TITLE,
    status: "connected",
  });

  const pane = getAllLeaves(useLayoutStore.getState().root).find((leaf) => leaf.id === firstPane.id);
  const index = pane?.sessionIds.indexOf(HOME_SESSION_ID) ?? -1;
  if (index > 0) useLayoutStore.getState().reorderSessionInPane(firstPane.id, index, 0);
}

export function openHome(): void {
  if (!useVaultStore.getState().isUnlocked) return;
  ensureHomeTab();
  focusSession(HOME_SESSION_ID);
  useSidebarStore.getState().autoCollapse();
}

/**
 * Brings Home back after anything that clears the sessions while a vault stays or becomes unlocked.
 * The check waits for a microtask: lockVault clears the sessions before it marks the vault locked.
 */
export function installHomeTabGuard(): () => void {
  let scheduled = false;
  let disposed = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) ensureHomeTab();
    });
  };

  const unsubscribeVault = useVaultStore.subscribe(schedule);
  const unsubscribeSessions = useSessionStore.subscribe(schedule);
  schedule();
  return () => {
    disposed = true;
    unsubscribeVault();
    unsubscribeSessions();
  };
}
