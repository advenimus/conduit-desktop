import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

import { useAiStore } from "../aiStore";
import { MAX_AGENT_PANES, bindPanesToActiveEngine, initialAgentPaneState, useAgentPaneStore } from "../agentPaneStore";

const initialAi = useAiStore.getState();
const engines = () => useAgentPaneStore.getState().panes.map((p) => p.engineType);
const focused = () => useAgentPaneStore.getState().focusedPaneId;
const ids = () => useAgentPaneStore.getState().panes.map((p) => p.id);

let unbind: () => void = () => undefined;

beforeEach(() => {
  useAiStore.setState({ ...initialAi, activeEngineType: "claude-code" }, true);
  useAgentPaneStore.setState(initialAgentPaneState());
  unbind = bindPanesToActiveEngine();
});

afterEach(() => {
  unbind();
  useAiStore.setState(initialAi, true);
});

describe("agentPaneStore", () => {
  it("starts with one pane on the header's engine, focused", () => {
    expect(engines()).toEqual(["claude-code"]);
    expect(focused()).toBe(ids()[0]);
  });

  it("adds panes with the header's engine, focuses each new one, and stops at the limit", () => {
    useAiStore.getState().setActiveEngine("codex");
    const second = useAgentPaneStore.getState().addPane();
    expect(second).not.toBeNull();
    expect(focused()).toBe(second);
    expect(engines()).toEqual(["codex", "codex"]);

    useAgentPaneStore.getState().addPane();
    expect(ids()).toHaveLength(MAX_AGENT_PANES);
    expect(useAgentPaneStore.getState().addPane()).toBeNull();
    expect(ids()).toHaveLength(MAX_AGENT_PANES);
    expect(new Set(ids()).size).toBe(MAX_AGENT_PANES);
  });

  it("switches only the focused pane's engine when activeEngineType changes", () => {
    const [first] = ids();
    useAgentPaneStore.getState().addPane();
    useAiStore.getState().setActiveEngine("codex");
    expect(engines()).toEqual(["claude-code", "codex"]);

    useAgentPaneStore.getState().focusPane(first);
    expect(useAiStore.getState().activeEngineType).toBe("claude-code");
    expect(engines()).toEqual(["claude-code", "codex"]);
  });

  it("swaps one pane's engine, mirroring it in activeEngineType only for the focused pane", () => {
    const [first] = ids();
    const second = useAgentPaneStore.getState().addPane()!;
    useAgentPaneStore.getState().setPaneEngine(first, "grok");
    expect(engines()).toEqual(["grok", "claude-code"]);
    expect(useAiStore.getState().activeEngineType).toBe("claude-code");

    useAgentPaneStore.getState().setPaneEngine(second, "codex");
    expect(engines()).toEqual(["grok", "codex"]);
    expect(useAiStore.getState().activeEngineType).toBe("codex");

    const before = useAgentPaneStore.getState().panes;
    useAgentPaneStore.getState().setPaneEngine(second, "codex");
    useAgentPaneStore.getState().setPaneEngine("nope", "codex");
    expect(useAgentPaneStore.getState().panes).toBe(before);
  });

  it("never closes the last pane", () => {
    const [only] = ids();
    useAgentPaneStore.getState().closePane(only);
    expect(ids()).toEqual([only]);
  });

  it("keeps focus when an unfocused pane closes", () => {
    const [first] = ids();
    const second = useAgentPaneStore.getState().addPane()!;
    useAgentPaneStore.getState().focusPane(first);
    useAgentPaneStore.getState().closePane(second);
    expect(ids()).toEqual([first]);
    expect(focused()).toBe(first);
  });

  it("moves focus to the pane that takes a closed focused pane's place, or the one above at the end", () => {
    const [first] = ids();
    const second = useAgentPaneStore.getState().addPane()!;
    useAiStore.getState().setActiveEngine("codex");
    const third = useAgentPaneStore.getState().addPane()!;
    useAiStore.getState().setActiveEngine("claude-code");
    expect(engines()).toEqual(["claude-code", "codex", "claude-code"]);

    useAgentPaneStore.getState().focusPane(first);
    useAgentPaneStore.getState().closePane(first);
    expect(focused()).toBe(second);
    expect(useAiStore.getState().activeEngineType).toBe("codex");

    useAgentPaneStore.getState().focusPane(third);
    useAgentPaneStore.getState().closePane(third);
    expect(ids()).toEqual([second]);
    expect(focused()).toBe(second);
    expect(useAiStore.getState().activeEngineType).toBe("codex");
  });

  it("ignores unknown pane ids", () => {
    const before = useAgentPaneStore.getState();
    useAgentPaneStore.getState().focusPane("nope");
    useAgentPaneStore.getState().closePane("nope");
    expect(useAgentPaneStore.getState().panes).toBe(before.panes);
    expect(focused()).toBe(before.focusedPaneId);
  });

  it("stops following activeEngineType once unbound", () => {
    unbind();
    useAiStore.getState().setActiveEngine("codex");
    expect(engines()).toEqual(["claude-code"]);
  });

  it("adopts the current engine when bound", () => {
    unbind();
    useAiStore.getState().setActiveEngine("codex");
    unbind = bindPanesToActiveEngine();
    expect(engines()).toEqual(["codex"]);
  });
});
