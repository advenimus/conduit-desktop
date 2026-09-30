import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOME_SESSION_ID, dashboardViewOf, entryInfoSessionId, folderViewSessionId, isHomeSession } from "../dashboardSessions";
import { openDashboardForEntry, openFolderView } from "../openDashboard";
import { useSessionStore } from "../../stores/sessionStore";
import { useEntryStore } from "../../stores/entryStore";
import { useLayoutStore, findLeaf } from "../../stores/layoutStore";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

describe("dashboardViewOf", () => {
  it("tells Home, entry info and folder view tabs apart", () => {
    expect(dashboardViewOf({ id: HOME_SESSION_ID })).toEqual({ kind: "home" });
    expect(dashboardViewOf({ id: entryInfoSessionId("e1"), entryId: "e1" })).toEqual({ kind: "entry", entryId: "e1" });
    expect(dashboardViewOf({ id: folderViewSessionId("f1"), metadata: { folderId: "f1" } })).toEqual({ kind: "folder", folderId: "f1" });
    expect(dashboardViewOf({ id: "other" })).toEqual({ kind: "home" });
  });

  it("knows the Home id", () => {
    expect(isHomeSession(HOME_SESSION_ID)).toBe(true);
    expect(isHomeSession("dashboard::x")).toBe(false);
    expect(isHomeSession(null)).toBe(false);
  });
});

describe("openFolderView and openDashboardForEntry", () => {
  beforeEach(() => {
    useSessionStore.getState().clearAll();
    useLayoutStore.getState().resetLayout();
    useEntryStore.setState({
      entries: [{ id: "e1", name: "web-01" }],
      folders: [{ id: "f1", name: "Production" }],
    } as never);
  });

  it("opens one folder tab and focuses it on a second call", () => {
    openFolderView("f1");
    openFolderView("f1");
    const tabs = useSessionStore.getState().sessions.filter((s) => s.id === folderViewSessionId("f1"));
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ type: "dashboard", title: "Production", metadata: { folderId: "f1" } });
  });

  it("does nothing for an unknown folder", () => {
    openFolderView("missing");
    expect(useSessionStore.getState().sessions).toHaveLength(0);
  });

  it("brings an open entry info tab to the front of its pane", () => {
    openDashboardForEntry("e1");
    openFolderView("f1");
    openDashboardForEntry("e1");
    const { root, focusedPaneId } = useLayoutStore.getState();
    expect(findLeaf(root, focusedPaneId)?.activeSessionId).toBe(entryInfoSessionId("e1"));
  });
});
