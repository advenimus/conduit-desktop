import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/electron", () => ({
  invoke,
  listen: vi.fn(async () => () => undefined),
  listenSync: vi.fn(() => () => undefined),
}));
vi.mock("../../sessions/TerminalView", () => ({ default: () => <div data-testid="terminal-view" /> }));

import ChatPanel from "../ChatPanel";
import { useAiStore, type EngineMessage } from "../../../stores/aiStore";

const initialState = useAiStore.getState();
const LEGACY = /bg-conduit-|text-conduit-|bg-panel|bg-raised|border-stroke|text-red-|bg-red-|text-amber-|focus:ring|text-xs|text-sm\b/;

const message = (id: string, role: EngineMessage["role"], text: string): EngineMessage => ({
  id,
  role,
  blocks: [{ type: "text", content: text }],
  timestamp: "2026-09-28T12:00:00.000Z",
});

async function renderPanel(settings: Record<string, unknown> = { default_engine: "claude-code", engine_picker_completed: true }) {
  invoke.mockImplementation(async (channel: string) => (channel === "settings_get" ? settings : channel === "agent_terminal_create" ? "term-1" : null));
  const view = render(<ChatPanel />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
  return view;
}

function body(): HTMLElement {
  const header = document.querySelector("[data-cv-ai-header]");
  const root = header?.parentElement;
  if (!root) throw new Error("no panel");
  return root;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  invoke.mockReset();
  useAiStore.setState({
    ...initialState,
    activeEngineType: "claude-code",
    activeEngineSessionId: null,
    engineSessions: [],
    engineMessages: [],
    engineStreamingBlocks: [],
    engineLoading: false,
    pendingEngineModel: null,
    terminalMode: false,
  });
});

afterEach(() => {
  useAiStore.setState(initialState, true);
});

describe("ChatPanel body (spec 3.7, R3-AI)", () => {
  it("keeps the empty state texts with the model in the link color", async () => {
    useAiStore.setState({ pendingEngineModel: "claude-opus-4" });
    await renderPanel();
    expect(screen.getByText("Claude Code Agent")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4", { selector: "p" })).toHaveClass("text-link");
    expect(screen.getByText("Send a message to start an agent session with MCP tool access")).toBeInTheDocument();
  });

  it("keeps the input: placeholder, a named send button, disabled while empty", async () => {
    await renderPanel();
    const field = screen.getByPlaceholderText("Message Claude Code... (type / then Enter for commands)");
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveClass("bg-input", "border-input-border");
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toHaveAttribute("title", "Send message");
    expect(send).toBeDisabled();
    fireEvent.change(field, { target: { value: "hi" } });
    expect(send).toBeEnabled();
    expect(send).toHaveClass("bg-btn-primary");
  });

  it("shows Stop generating while the engine works, with the thinking text", async () => {
    useAiStore.setState({ engineLoading: true, cancelEngineMessage: vi.fn() });
    await renderPanel();
    const stop = screen.getByRole("button", { name: "Stop generating" });
    expect(stop).toHaveAttribute("title", "Stop generating");
    expect(stop).toHaveClass("bg-btn-danger");
    fireEvent.click(stop);
    expect(useAiStore.getState().cancelEngineMessage).toHaveBeenCalled();
    expect(screen.getByText("Claude Code is thinking...")).toBeInTheDocument();
  });

  it("renders messages with named edit and regenerate buttons revealed by opacity only", async () => {
    const retryEngineMessage = vi.fn(async () => undefined);
    useAiStore.setState({
      engineMessages: [message("u1", "user", "Hello there"), message("a1", "assistant", "General Kenobi"), message("s1", "system", "Session started")],
      retryEngineMessage,
    });
    await renderPanel();
    expect(screen.getByText("Hello there").closest(".rounded-lg")).toHaveClass("bg-btn-primary", "text-white");
    expect(screen.getByText("General Kenobi").closest(".rounded-lg")).toHaveClass("bg-well", "border-card-border");
    expect(screen.getByText("Session started")).toBeInTheDocument();

    const edit = screen.getByRole("button", { name: "Edit message" });
    const regenerate = screen.getByRole("button", { name: "Regenerate response" });
    expect(edit).toHaveAttribute("title", "Edit message");
    expect(regenerate).toHaveAttribute("title", "Regenerate response");
    const reveal = edit.parentElement as HTMLElement;
    expect(reveal).toHaveClass("opacity-0", "group-hover:opacity-100");
    expect(reveal.className).not.toMatch(/\b(hidden|invisible)\b/);

    fireEvent.click(regenerate);
    expect(retryEngineMessage).toHaveBeenCalledWith(1);
  });

  it("keeps the editing indicator texts and its Cancel button", async () => {
    useAiStore.setState({ engineMessages: [message("u1", "user", "Hello there")] });
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(screen.getByText(/Editing message — session context will reset from here/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Edit your message...")).toHaveValue("Hello there");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Editing message/)).toBeNull();
  });

  it("opens the slash command menu with the overlay look and the menu selection", async () => {
    await renderPanel();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    const menu = document.querySelector<HTMLElement>(".absolute.bottom-full");
    expect(menu).not.toBeNull();
    expect(menu).toHaveClass("bg-overlay", "border-overlay-border");
    const items = menu!.querySelectorAll("button");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].className).toContain("bg-(--c-menu-selection-bg)");
  });

  it("shows the terminal-mode busy text and the failure with Retry", async () => {
    useAiStore.setState({ terminalMode: true });
    let reject: (e: Error) => void = () => undefined;
    invoke.mockImplementation((channel: string) => {
      if (channel === "settings_get") return Promise.resolve({ default_engine: "claude-code", engine_picker_completed: true });
      if (channel === "agent_terminal_create") return new Promise((_, r) => (reject = r));
      return Promise.resolve(null);
    });
    render(<ChatPanel />);
    expect(await screen.findByText("Starting Claude Code...")).toBeInTheDocument();
    await act(async () => reject(new Error("claude not found")));
    expect(screen.getByText("Failed to start terminal")).toBeInTheDocument();
    expect(screen.getByText("claude not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass("bg-btn-primary");
  });

  it("shows the terminal once it starts", async () => {
    useAiStore.setState({ terminalMode: true });
    await renderPanel();
    expect(await screen.findByTestId("terminal-view")).toBeInTheDocument();
  });

  it("uses no legacy classes in the body", async () => {
    useAiStore.setState({
      pendingEngineModel: "claude-opus-4",
      engineMessages: [message("u1", "user", "Hello"), message("a1", "assistant", "Hi"), message("s1", "system", "Note")],
      engineStreamingBlocks: [{ type: "text", content: "streaming" }],
    });
    await renderPanel();
    const offenders = [...body().querySelectorAll<HTMLElement>("[class]")].filter((el) => LEGACY.test(el.getAttribute("class") ?? ""));
    expect(offenders.map((el) => el.getAttribute("class"))).toEqual([]);
  });
});
