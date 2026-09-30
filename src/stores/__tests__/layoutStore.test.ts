import { beforeEach, describe, expect, it, vi } from "vitest";
import { findLeaf, getAllLeaves, useLayoutStore, type LayoutNode } from "../layoutStore";
import { HOME_SESSION_ID } from "../../lib/dashboardSessions";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const H = HOME_SESSION_ID;

function leaf(id: string, sessionIds: string[]): LayoutNode {
  return { type: "leaf", id, sessionIds, activeSessionId: sessionIds[0] ?? null };
}

function setRoot(root: LayoutNode, focused = "pane-a") {
  useLayoutStore.setState({ root, focusedPaneId: focused });
}

const paneIds = (paneId: string) => findLeaf(useLayoutStore.getState().root, paneId)?.sessionIds;

beforeEach(() => {
  setRoot(leaf("pane-a", [H, "a", "b", "c"]));
});

describe("layoutStore and the pinned Home tab", () => {
  it("does not move Home to another pane", () => {
    setRoot({
      type: "branch",
      id: "br",
      direction: "horizontal",
      sizes: [50, 50],
      children: [leaf("pane-a", [H, "a"]), leaf("pane-b", ["b"])],
    });
    const before = useLayoutStore.getState().root;
    useLayoutStore.getState().moveSessionToPane(H, "pane-b");
    expect(useLayoutStore.getState().root).toBe(before);
  });

  it("does not split Home into a new pane, from its own pane or another", () => {
    const before = useLayoutStore.getState().root;
    useLayoutStore.getState().moveSessionToNewSplit(H, "pane-a", "horizontal");
    useLayoutStore.getState().moveSessionToNewSplit(H, "pane-a", "vertical", "before");
    useLayoutStore.getState().splitPane("pane-a", "horizontal", H);
    expect(useLayoutStore.getState().root).toBe(before);
  });

  it("still splits a pane without a session, leaving Home where it is", () => {
    useLayoutStore.getState().splitPane("pane-a", "horizontal");
    const leaves = getAllLeaves(useLayoutStore.getState().root);
    expect(leaves.map((l) => l.sessionIds)).toEqual([[H, "a", "b", "c"], []]);
  });

  it("keeps Home first when something tries to reorder it", () => {
    useLayoutStore.getState().reorderSessionInPane("pane-a", 0, 3);
    expect(paneIds("pane-a")).toEqual([H, "a", "b", "c"]);
  });

  it("lands another tab dropped at index 0 at index 1", () => {
    useLayoutStore.getState().reorderSessionInPane("pane-a", 3, 0);
    expect(paneIds("pane-a")).toEqual([H, "c", "a", "b"]);
  });

  it("reorders other tabs behind Home as before", () => {
    useLayoutStore.getState().reorderSessionInPane("pane-a", 1, 3);
    expect(paneIds("pane-a")).toEqual([H, "b", "c", "a"]);
    useLayoutStore.getState().reorderSessionInPane("pane-a", 3, 1);
    expect(paneIds("pane-a")).toEqual([H, "a", "b", "c"]);
  });

  it("moves Home to index 0 when asked to, which is how it is placed", () => {
    setRoot(leaf("pane-a", ["a", "b", H]));
    useLayoutStore.getState().reorderSessionInPane("pane-a", 2, 0);
    expect(paneIds("pane-a")).toEqual([H, "a", "b"]);
  });

  it("reorders panes without Home with no clamp", () => {
    setRoot(leaf("pane-a", ["a", "b", "c"]));
    useLayoutStore.getState().reorderSessionInPane("pane-a", 2, 0);
    expect(paneIds("pane-a")).toEqual(["c", "a", "b"]);
  });

  it("still removes Home from its pane, as after clearAll", () => {
    setRoot(leaf("pane-a", [H]));
    useLayoutStore.getState().removeSessionFromPane(H);
    expect(paneIds("pane-a")).toEqual([]);
  });
});
