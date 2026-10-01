import { create } from "zustand";
import { useAiStore, type EngineType } from "./aiStore";

export const MAX_AGENT_PANES = 3;

export interface AgentPane {
  readonly id: string;
  readonly engineType: EngineType;
}

interface AgentPaneState {
  panes: readonly AgentPane[];
  focusedPaneId: string;
  /** Adds a pane running the header's engine and focuses it. Returns null at the limit. */
  addPane: () => string | null;
  /** Closes a pane. The last pane never closes. */
  closePane: (id: string) => void;
  focusPane: (id: string) => void;
}

const newPane = (engineType: EngineType): AgentPane => ({ id: crypto.randomUUID(), engineType });

export function initialAgentPaneState(): Pick<AgentPaneState, "panes" | "focusedPaneId"> {
  const pane = newPane(useAiStore.getState().activeEngineType);
  return { panes: [pane], focusedPaneId: pane.id };
}

// activeEngineType always mirrors the focused pane, so the header switcher and every other
// setActiveEngine caller (picker, settings, the new-agent shortcut) act on the focused pane.
function showEngineOf(pane: AgentPane): void {
  useAiStore.getState().setActiveEngine(pane.engineType);
}

export const useAgentPaneStore = create<AgentPaneState>((set, get) => ({
  ...initialAgentPaneState(),

  addPane: () => {
    const { panes } = get();
    if (panes.length >= MAX_AGENT_PANES) return null;
    const pane = newPane(useAiStore.getState().activeEngineType);
    set({ panes: [...panes, pane], focusedPaneId: pane.id });
    return pane.id;
  },

  closePane: (id) => {
    const { panes, focusedPaneId } = get();
    const index = panes.findIndex((p) => p.id === id);
    if (index < 0 || panes.length <= 1) return;
    const remaining = panes.filter((p) => p.id !== id);
    if (focusedPaneId !== id) {
      set({ panes: remaining });
      return;
    }
    const nextFocus = remaining[Math.min(index, remaining.length - 1)];
    set({ panes: remaining, focusedPaneId: nextFocus.id });
    showEngineOf(nextFocus);
  },

  focusPane: (id) => {
    const { panes, focusedPaneId } = get();
    const pane = panes.find((p) => p.id === id);
    if (!pane || id === focusedPaneId) return;
    set({ focusedPaneId: id });
    showEngineOf(pane);
  },
}));

function applyEngineToFocusedPane(engineType: EngineType): void {
  const { panes, focusedPaneId } = useAgentPaneStore.getState();
  if (panes.find((p) => p.id === focusedPaneId)?.engineType === engineType) return;
  useAgentPaneStore.setState({
    panes: panes.map((p) => (p.id === focusedPaneId ? { ...p, engineType } : p)),
  });
}

/** Keeps the focused pane's engine in step with activeEngineType. Returns the unsubscribe. */
export function bindPanesToActiveEngine(): () => void {
  applyEngineToFocusedPane(useAiStore.getState().activeEngineType);
  return useAiStore.subscribe((state, prev) => {
    if (state.activeEngineType !== prev.activeEngineType) applyEngineToFocusedPane(state.activeEngineType);
  });
}
