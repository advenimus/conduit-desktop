import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/electron", () => ({
  invoke,
  listen: vi.fn(async () => () => undefined),
  listenSync: vi.fn(() => () => undefined),
}));
vi.mock("../../sessions/TerminalView", () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="terminal-view" data-session={sessionId} />,
  disposeTerminalEntry: vi.fn(),
}));

import ChatPanel from "../ChatPanel";
import { useAiStore } from "../../../stores/aiStore";
import { initialAgentPaneState, useAgentPaneStore } from "../../../stores/agentPaneStore";

const initialAi = useAiStore.getState();
const LIMIT_REASON = "Up to 3 agents can run at once";

interface Created {
  sessionId: string;
  engineType: string;
  paneId: string;
}

let created: Created[] = [];
let settings: Record<string, unknown> = {};
let holdCreates = false;
let pendingCreates: Array<() => void> = [];

const closed = () => invoke.mock.calls.filter(([ch]) => ch === "terminal_close").map(([, args]) => (args as { sessionId: string }).sessionId);
const open = () => created.map((c) => c.sessionId).filter((id) => !closed().includes(id));
const shown = () => screen.queryAllByTestId("terminal-view").map((el) => el.getAttribute("data-session"));
const plus = () => screen.getByRole("button", { name: "New agent" });
const closeButtons = () => screen.queryAllByRole("button", { name: /^Close .* agent$/ });

async function renderPanel() {
  const view = render(<ChatPanel />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
  return view;
}

async function addPane() {
  const before = created.length;
  fireEvent.click(plus());
  await waitFor(() => expect(created.length).toBe(before + 1));
}

beforeEach(() => {
  created = [];
  pendingCreates = [];
  holdCreates = false;
  settings = { default_engine: "claude-code", engine_picker_completed: true };
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string, args?: { engineType: string; paneId: string }) => {
    if (channel === "settings_get") return settings;
    if (channel === "agent_terminal_create") {
      const entry = { sessionId: `term-${created.length + 1}`, engineType: args!.engineType, paneId: args!.paneId };
      if (holdCreates) {
        return new Promise((resolve) => pendingCreates.push(() => (created.push(entry), resolve(entry.sessionId))));
      }
      created.push(entry);
      return entry.sessionId;
    }
    return null;
  });
  useAiStore.setState({ ...initialAi, activeEngineType: "claude-code", terminalMode: true }, true);
  useAgentPaneStore.setState(initialAgentPaneState());
});

afterEach(() => {
  useAiStore.setState(initialAi, true);
});

describe("ChatPanel agent panes", () => {
  it("runs one agent without a pane header, passing the pane id to the main process", async () => {
    await renderPanel();
    await waitFor(() => expect(shown()).toEqual(["term-1"]));
    expect(created).toEqual([{ sessionId: "term-1", engineType: "claude-code", paneId: useAgentPaneStore.getState().panes[0].id }]);
    expect(closeButtons()).toHaveLength(0);
    expect(document.querySelectorAll("[role=separator]")).toHaveLength(0);
  });

  it("stacks up to three agents, each with a close button, and disables + at the limit", async () => {
    await renderPanel();
    await waitFor(() => expect(created).toHaveLength(1));

    await addPane();
    await waitFor(() => expect(shown()).toEqual(["term-1", "term-2"]));
    expect(closeButtons()).toHaveLength(2);
    expect(document.querySelectorAll("[role=separator]")).toHaveLength(1);
    expect(new Set(created.map((c) => c.paneId)).size).toBe(2);
    expect(useAgentPaneStore.getState().focusedPaneId).toBe(created[1].paneId);

    await addPane();
    await waitFor(() => expect(shown()).toEqual(["term-1", "term-2", "term-3"]));
    expect(plus()).toBeDisabled();
    expect(plus()).toHaveAttribute("title", LIMIT_REASON);
    expect(document.querySelectorAll("[role=separator]")).toHaveLength(2);
    expect(closed()).toEqual([]);
  });

  it("closes the middle agent and ends only its terminal", async () => {
    await renderPanel();
    await waitFor(() => expect(created).toHaveLength(1));
    await addPane();
    await addPane();
    await waitFor(() => expect(shown()).toHaveLength(3));

    const middle = document.querySelector<HTMLElement>(`[data-agent-pane="${created[1].paneId}"]`)!;
    fireEvent.click(within(middle).getByRole("button", { name: "Close Claude Code agent" }));

    await waitFor(() => expect(closed()).toEqual(["term-2"]));
    expect(shown()).toEqual(["term-1", "term-3"]);
    expect(plus()).toBeEnabled();
    expect(created).toHaveLength(3);

    fireEvent.click(closeButtons()[0]);
    await waitFor(() => expect(closed()).toEqual(["term-2", "term-1"]));
    expect(shown()).toEqual(["term-3"]);
    expect(closeButtons()).toHaveLength(0);
  });

  it("swaps only the focused agent's engine from the header", async () => {
    await renderPanel();
    await waitFor(() => expect(created).toHaveLength(1));
    await addPane();
    await waitFor(() => expect(shown()).toHaveLength(2));

    fireEvent.click(screen.getByTitle("Switch engine for this session"));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Codex/ }));

    await waitFor(() => expect(created).toHaveLength(3));
    expect(created[2]).toMatchObject({ engineType: "codex", paneId: created[1].paneId });
    await waitFor(() => expect(closed()).toEqual(["term-2"]));
    expect(shown()).toEqual(["term-1", "term-3"]);

    fireEvent.mouseDown(document.querySelector(`[data-agent-pane="${created[0].paneId}"]`)!);
    expect(screen.getByTitle("Switch engine for this session")).toHaveTextContent("Claude Code");
    expect(created).toHaveLength(3);
  });

  it("restarts every agent when the agent session epoch changes", async () => {
    await renderPanel();
    await waitFor(() => expect(created).toHaveLength(1));
    await addPane();
    await waitFor(() => expect(shown()).toHaveLength(2));

    act(() => useAiStore.getState().bumpAgentSession());
    await waitFor(() => expect(shown()).toEqual(["term-3", "term-4"]));
    expect(closed().sort()).toEqual(["term-1", "term-2"]);
    expect(created.slice(2).map((c) => c.paneId)).toEqual(created.slice(0, 2).map((c) => c.paneId));
  });

  it("ends every terminal on unmount", async () => {
    const view = await renderPanel();
    await waitFor(() => expect(created).toHaveLength(1));
    await addPane();
    await waitFor(() => expect(shown()).toHaveLength(2));
    view.unmount();
    await waitFor(() => expect(open()).toEqual([]));
  });

  it("ends a terminal that finishes starting after its agent was closed", async () => {
    await renderPanel();
    await waitFor(() => expect(created).toHaveLength(1));
    holdCreates = true;
    fireEvent.click(plus());
    await waitFor(() => expect(pendingCreates).toHaveLength(1));
    expect(screen.getByText("Starting Claude Code...")).toBeInTheDocument();

    fireEvent.click(closeButtons()[1]);
    await act(async () => pendingCreates[0]());
    await waitFor(() => expect(closed()).toEqual(["term-2"]));
    expect(open()).toEqual(["term-1"]);
  });

  it("starts no agent until the first-launch picker is answered", async () => {
    settings = { engine_picker_completed: false };
    await renderPanel();
    await screen.findByText("Choose your AI agent");
    expect(created).toHaveLength(0);
  });
});
