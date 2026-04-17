import { create } from "zustand";
import { useSessionStore } from "./sessionStore";

// ---- Types ----

export interface LayoutLeaf {
  type: "leaf";
  id: string;
  sessionIds: string[];
  activeSessionId: string | null;
}

export interface LayoutBranch {
  type: "branch";
  id: string;
  direction: "horizontal" | "vertical";
  children: [LayoutNode, LayoutNode];
  sizes: [number, number];
}

export type LayoutNode = LayoutLeaf | LayoutBranch;

// ---- Pure helpers ----

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

export function findLeaf(node: LayoutNode, id: string): LayoutLeaf | null {
  if (node.type === "leaf") return node.id === id ? node : null;
  return findLeaf(node.children[0], id) || findLeaf(node.children[1], id);
}

function findLeafForSession(node: LayoutNode, sessionId: string): LayoutLeaf | null {
  if (node.type === "leaf") return node.sessionIds.includes(sessionId) ? node : null;
  return (
    findLeafForSession(node.children[0], sessionId) ||
    findLeafForSession(node.children[1], sessionId)
  );
}

export function getAllLeaves(node: LayoutNode): LayoutLeaf[] {
  if (node.type === "leaf") return [node];
  return [...getAllLeaves(node.children[0]), ...getAllLeaves(node.children[1])];
}

function getFirstLeaf(node: LayoutNode): LayoutLeaf {
  if (node.type === "leaf") return node;
  return getFirstLeaf(node.children[0]);
}

function updateLeaf(
  root: LayoutNode,
  leafId: string,
  updater: (leaf: LayoutLeaf) => LayoutLeaf,
): LayoutNode {
  if (root.type === "leaf") return root.id === leafId ? updater(root) : root;
  const newChildren: [LayoutNode, LayoutNode] = [
    updateLeaf(root.children[0], leafId, updater),
    updateLeaf(root.children[1], leafId, updater),
  ];
  if (newChildren[0] === root.children[0] && newChildren[1] === root.children[1]) return root;
  return { ...root, children: newChildren };
}

function replaceNode(
  root: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (root.id === targetId) return replacement;
  if (root.type === "leaf") return root;
  const newChildren: [LayoutNode, LayoutNode] = [
    replaceNode(root.children[0], targetId, replacement),
    replaceNode(root.children[1], targetId, replacement),
  ];
  if (newChildren[0] === root.children[0] && newChildren[1] === root.children[1]) return root;
  return { ...root, children: newChildren };
}

function findParentBranch(root: LayoutNode, targetId: string): LayoutBranch | null {
  if (root.type === "leaf") return null;
  if (root.children[0].id === targetId || root.children[1].id === targetId) return root;
  return (
    findParentBranch(root.children[0], targetId) ||
    findParentBranch(root.children[1], targetId)
  );
}

function updateBranchSizes(
  node: LayoutNode,
  branchId: string,
  sizes: [number, number],
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === branchId) return { ...node, sizes };
  const newChildren: [LayoutNode, LayoutNode] = [
    updateBranchSizes(node.children[0], branchId, sizes),
    updateBranchSizes(node.children[1], branchId, sizes),
  ];
  if (newChildren[0] === node.children[0] && newChildren[1] === node.children[1]) return node;
  return { ...node, children: newChildren };
}

// Collapse an empty leaf inside a root, returning [newRoot, newFocusedPaneId | null]
function collapseEmptyLeaf(
  root: LayoutNode,
  paneId: string,
  currentFocusedId: string,
): { root: LayoutNode; focusedPaneId: string } | null {
  // Don't collapse the only pane (root is leaf)
  if (root.type === "leaf") return null;

  const parent = findParentBranch(root, paneId);
  if (!parent) return null;

  const sibling =
    parent.children[0].id === paneId ? parent.children[1] : parent.children[0];
  const newRoot = replaceNode(root, parent.id, sibling);

  let newFocused = currentFocusedId;
  if (currentFocusedId === paneId) {
    newFocused = getFirstLeaf(sibling).id;
  }
  // If focused pane no longer exists in tree, fall back to first leaf
  if (!findLeaf(newRoot, newFocused)) {
    newFocused = getFirstLeaf(newRoot).id;
  }

  return { root: newRoot, focusedPaneId: newFocused };
}

// ---- Store ----

const DEFAULT_PANE_ID = "default";

interface LayoutState {
  root: LayoutNode;
  focusedPaneId: string;

  addSessionToPane: (sessionId: string, paneId?: string) => void;
  removeSessionFromPane: (sessionId: string) => void;
  replaceSessionInPane: (oldId: string, newId: string) => void;
  setActiveSessionInPane: (paneId: string, sessionId: string | null) => void;
  setFocusedPane: (paneId: string) => void;
  splitPane: (
    paneId: string,
    direction: "horizontal" | "vertical",
    sessionId?: string,
    position?: "before" | "after",
  ) => void;
  moveSessionToPane: (sessionId: string, targetPaneId: string) => void;
  moveSessionToNewSplit: (
    sessionId: string,
    targetPaneId: string,
    direction: "horizontal" | "vertical",
    position?: "before" | "after",
  ) => void;
  collapsePaneIfEmpty: (paneId: string) => void;
  updateSizes: (branchId: string, sizes: [number, number]) => void;
  reorderSessionInPane: (paneId: string, fromIndex: number, toIndex: number) => void;
  syncActiveSessionToStore: () => void;
  resetLayout: () => void;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  root: {
    type: "leaf",
    id: DEFAULT_PANE_ID,
    sessionIds: [],
    activeSessionId: null,
  },
  focusedPaneId: DEFAULT_PANE_ID,

  addSessionToPane: (sessionId, paneId) => {
    set((state) => {
      const targetId = paneId ?? state.focusedPaneId;
      if (findLeafForSession(state.root, sessionId)) return state;
      return {
        root: updateLeaf(state.root, targetId, (leaf) => ({
          ...leaf,
          sessionIds: [...leaf.sessionIds, sessionId],
          activeSessionId: sessionId,
        })),
      };
    });
    get().syncActiveSessionToStore();
  },

  removeSessionFromPane: (sessionId) => {
    let emptiedPaneId: string | null = null;

    set((state) => {
      const pane = findLeafForSession(state.root, sessionId);
      if (!pane) return state;

      const newSessionIds = pane.sessionIds.filter((id) => id !== sessionId);
      const newActive =
        pane.activeSessionId === sessionId
          ? newSessionIds.length > 0
            ? newSessionIds[newSessionIds.length - 1]
            : null
          : pane.activeSessionId;

      if (newSessionIds.length === 0) {
        emptiedPaneId = pane.id;
      }

      return {
        root: updateLeaf(state.root, pane.id, () => ({
          ...pane,
          sessionIds: newSessionIds,
          activeSessionId: newActive,
        })),
      };
    });

    if (emptiedPaneId) {
      get().collapsePaneIfEmpty(emptiedPaneId);
    }
    get().syncActiveSessionToStore();
  },

  replaceSessionInPane: (oldId, newId) => {
    set((state) => {
      const pane = findLeafForSession(state.root, oldId);
      if (!pane) return state;

      return {
        root: updateLeaf(state.root, pane.id, (leaf) => ({
          ...leaf,
          sessionIds: leaf.sessionIds.map((id) => (id === oldId ? newId : id)),
          activeSessionId: leaf.activeSessionId === oldId ? newId : leaf.activeSessionId,
        })),
      };
    });
    get().syncActiveSessionToStore();
  },

  setActiveSessionInPane: (paneId, sessionId) => {
    set((state) => ({
      root: updateLeaf(state.root, paneId, (leaf) => ({
        ...leaf,
        activeSessionId: sessionId,
      })),
    }));
    get().syncActiveSessionToStore();
  },

  setFocusedPane: (paneId) => {
    set({ focusedPaneId: paneId });
    get().syncActiveSessionToStore();
  },

  splitPane: (paneId, direction, sessionId, position = "after") => {
    set((state) => {
      const pane = findLeaf(state.root, paneId);
      if (!pane) return state;

      const newPaneId = generateId();
      let sourceSessionIds: string[];
      let newPaneSessionIds: string[];
      let newPaneActive: string | null;
      let sourceActive: string | null;

      if (sessionId) {
        sourceSessionIds = pane.sessionIds.filter((id) => id !== sessionId);
        newPaneSessionIds = [sessionId];
        newPaneActive = sessionId;
        sourceActive =
          sourceSessionIds.length > 0
            ? pane.activeSessionId && sourceSessionIds.includes(pane.activeSessionId)
              ? pane.activeSessionId
              : sourceSessionIds[0]
            : null;
      } else {
        sourceSessionIds = [...pane.sessionIds];
        newPaneSessionIds = [];
        newPaneActive = null;
        sourceActive = pane.activeSessionId;
      }

      const sourceNode: LayoutLeaf = {
        type: "leaf",
        id: pane.id,
        sessionIds: sourceSessionIds,
        activeSessionId: sourceActive,
      };
      const newPaneNode: LayoutLeaf = {
        type: "leaf",
        id: newPaneId,
        sessionIds: newPaneSessionIds,
        activeSessionId: newPaneActive,
      };

      const children: [LayoutNode, LayoutNode] =
        position === "after" ? [sourceNode, newPaneNode] : [newPaneNode, sourceNode];

      const newBranch: LayoutBranch = {
        type: "branch",
        id: generateId(),
        direction,
        children,
        sizes: [50, 50],
      };

      return {
        root: replaceNode(state.root, paneId, newBranch),
        focusedPaneId: sessionId ? newPaneId : pane.id,
      };
    });
    get().syncActiveSessionToStore();
    document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 150);
  },

  moveSessionToPane: (sessionId, targetPaneId) => {
    set((state) => {
      const sourcePane = findLeafForSession(state.root, sessionId);
      if (!sourcePane || sourcePane.id === targetPaneId) return state;

      // Remove from source
      const sourceSessionIds = sourcePane.sessionIds.filter((id) => id !== sessionId);
      const sourceActive =
        sourcePane.activeSessionId === sessionId
          ? sourceSessionIds.length > 0
            ? sourceSessionIds[sourceSessionIds.length - 1]
            : null
          : sourcePane.activeSessionId;

      let newRoot = updateLeaf(state.root, sourcePane.id, () => ({
        ...sourcePane,
        sessionIds: sourceSessionIds,
        activeSessionId: sourceActive,
      }));

      // Add to target
      const targetPane = findLeaf(newRoot, targetPaneId);
      if (!targetPane) return { root: newRoot };

      newRoot = updateLeaf(newRoot, targetPaneId, (leaf) => ({
        ...leaf,
        sessionIds: [...leaf.sessionIds, sessionId],
        activeSessionId: sessionId,
      }));

      // Collapse source if empty
      if (sourceSessionIds.length === 0) {
        const collapsed = collapseEmptyLeaf(newRoot, sourcePane.id, targetPaneId);
        if (collapsed) {
          return collapsed;
        }
      }

      return { root: newRoot, focusedPaneId: targetPaneId };
    });
    get().syncActiveSessionToStore();
    // Immediate + delayed dispatch to catch post-render container size changes
    document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 150);
  },

  moveSessionToNewSplit: (sessionId, targetPaneId, direction, position = "after") => {
    set((state) => {
      const sourcePane = findLeafForSession(state.root, sessionId);
      if (!sourcePane) return state;

      // Same pane: split with session
      if (sourcePane.id === targetPaneId) {
        const newPaneId = generateId();
        const sourceSessionIds = sourcePane.sessionIds.filter((id) => id !== sessionId);
        const sourceActive =
          sourceSessionIds.length > 0
            ? sourcePane.activeSessionId && sourceSessionIds.includes(sourcePane.activeSessionId)
              ? sourcePane.activeSessionId
              : sourceSessionIds[0]
            : null;

        const sourceNode: LayoutLeaf = {
          type: "leaf",
          id: sourcePane.id,
          sessionIds: sourceSessionIds,
          activeSessionId: sourceActive,
        };
        const newPaneNode: LayoutLeaf = {
          type: "leaf",
          id: newPaneId,
          sessionIds: [sessionId],
          activeSessionId: sessionId,
        };

        const children: [LayoutNode, LayoutNode] =
          position === "after" ? [sourceNode, newPaneNode] : [newPaneNode, sourceNode];

        const newBranch: LayoutBranch = {
          type: "branch",
          id: generateId(),
          direction,
          children,
          sizes: [50, 50],
        };

        return {
          root: replaceNode(state.root, sourcePane.id, newBranch),
          focusedPaneId: newPaneId,
        };
      }

      // Different panes: remove from source, split target
      const sourceSessionIds = sourcePane.sessionIds.filter((id) => id !== sessionId);
      const sourceActive =
        sourcePane.activeSessionId === sessionId
          ? sourceSessionIds.length > 0
            ? sourceSessionIds[sourceSessionIds.length - 1]
            : null
          : sourcePane.activeSessionId;

      let newRoot = updateLeaf(state.root, sourcePane.id, () => ({
        ...sourcePane,
        sessionIds: sourceSessionIds,
        activeSessionId: sourceActive,
      }));

      // Collapse source if empty
      if (sourceSessionIds.length === 0) {
        const collapsed = collapseEmptyLeaf(newRoot, sourcePane.id, state.focusedPaneId);
        if (collapsed) {
          newRoot = collapsed.root;
        }
      }

      // Split target pane with the session (target may have moved if collapse restructured tree)
      let resolvedTargetId = targetPaneId;
      let targetPane = findLeaf(newRoot, targetPaneId);
      if (!targetPane) {
        // Target disappeared after collapse — fall back to first available pane
        targetPane = getFirstLeaf(newRoot);
        resolvedTargetId = targetPane.id;
      }

      const newPaneId = generateId();
      const newPaneNode: LayoutLeaf = {
        type: "leaf",
        id: newPaneId,
        sessionIds: [sessionId],
        activeSessionId: sessionId,
      };

      const children: [LayoutNode, LayoutNode] =
        position === "after" ? [targetPane, newPaneNode] : [newPaneNode, targetPane];

      const newBranch: LayoutBranch = {
        type: "branch",
        id: generateId(),
        direction,
        children,
        sizes: [50, 50],
      };

      return {
        root: replaceNode(newRoot, resolvedTargetId, newBranch),
        focusedPaneId: newPaneId,
      };
    });
    get().syncActiveSessionToStore();
    document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 150);
  },

  collapsePaneIfEmpty: (paneId) => {
    let didCollapse = false;
    set((state) => {
      const pane = findLeaf(state.root, paneId);
      if (!pane || pane.sessionIds.length > 0) return state;

      const collapsed = collapseEmptyLeaf(state.root, paneId, state.focusedPaneId);
      if (collapsed) didCollapse = true;
      return collapsed ?? state;
    });
    if (didCollapse) {
      document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
      setTimeout(() => document.dispatchEvent(new CustomEvent("conduit:layout-changed")), 150);
    }
  },

  updateSizes: (branchId, sizes) => {
    set((state) => {
      const newRoot = updateBranchSizes(state.root, branchId, sizes);
      return newRoot === state.root ? state : { root: newRoot };
    });
  },

  reorderSessionInPane: (paneId, fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    set((state) => ({
      root: updateLeaf(state.root, paneId, (leaf) => {
        const sessionIds = [...leaf.sessionIds];
        const [moved] = sessionIds.splice(fromIndex, 1);
        sessionIds.splice(toIndex, 0, moved);
        return { ...leaf, sessionIds };
      }),
    }));
  },

  syncActiveSessionToStore: () => {
    const { root, focusedPaneId } = get();
    const pane = findLeaf(root, focusedPaneId);
    const activeId = pane?.activeSessionId ?? null;
    if (useSessionStore.getState().activeSessionId !== activeId) {
      layoutSyncing = true;
      useSessionStore.getState().setActiveSession(activeId);
      layoutSyncing = false;
    }
  },

  resetLayout: () => {
    set({
      root: {
        type: "leaf",
        id: DEFAULT_PANE_ID,
        sessionIds: [],
        activeSessionId: null,
      },
      focusedPaneId: DEFAULT_PANE_ID,
    });
  },
}));

// ---- Session store subscription ----

// Guard flag to prevent re-entrant subscription when layoutStore syncs back to sessionStore
let layoutSyncing = false;
let prevSessionIds: string[] = [];

useSessionStore.subscribe((state) => {
  if (layoutSyncing) return;
  const currentIds = state.sessions.map((s) => s.id);
  const currentSet = new Set(currentIds);
  const prevSet = new Set(prevSessionIds);

  const added = currentIds.filter((id) => !prevSet.has(id));
  const removed = prevSessionIds.filter((id) => !currentSet.has(id));

  prevSessionIds = currentIds;

  if (added.length === 0 && removed.length === 0) return;

  const layoutStore = useLayoutStore.getState();

  // Detect replaceSessionId: exactly one added + one removed
  if (added.length === 1 && removed.length === 1) {
    layoutStore.replaceSessionInPane(removed[0], added[0]);
    return;
  }

  for (const id of added) {
    layoutStore.addSessionToPane(id);
  }
  for (const id of removed) {
    layoutStore.removeSessionFromPane(id);
  }
});
