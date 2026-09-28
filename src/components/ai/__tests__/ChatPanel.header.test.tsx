import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/electron", () => ({
  invoke,
  listen: vi.fn(async () => () => undefined),
  listenSync: vi.fn(() => () => undefined),
}));
vi.mock("../../sessions/TerminalView", () => ({ default: () => <div data-testid="terminal-view" /> }));

import ChatPanel from "../ChatPanel";
import { useAiStore } from "../../../stores/aiStore";
import { ENGINE_TYPES, getHarness } from "../../../lib/ai-harnesses";

const SWITCH_TITLE = "Switch engine for this session";
const initialState = useAiStore.getState();

function header(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-cv-ai-header]");
  if (!el) throw new Error("no [data-cv-ai-header]");
  return el;
}

function headerButtons(): HTMLButtonElement[] {
  return [...header().querySelectorAll<HTMLButtonElement>(":scope button")].filter((b) => !b.closest("[role=menu]"));
}

async function renderPanel() {
  render(<ChatPanel />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
}

beforeEach(() => {
  // jsdom has no scrollIntoView; the message list scrolls on every render.
  Element.prototype.scrollIntoView = vi.fn();
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) =>
    channel === "settings_get" ? { default_engine: "claude-code", engine_picker_completed: true } : null,
  );
  useAiStore.setState({
    ...initialState,
    activeEngineType: "claude-code",
    activeEngineSessionId: null,
    engineSessions: [],
    pendingEngineModel: null,
    terminalMode: false,
  });
});

afterEach(() => {
  useAiStore.setState(initialState, true);
});

describe("ChatPanel header (spec 3.7)", () => {
  it("sits on the side bar surface and marks the 33px header row without a bottom border", async () => {
    await renderPanel();
    const row = header();
    expect(row.parentElement).toHaveClass("bg-sidebar");
    expect(row.parentElement).not.toHaveClass("bg-canvas");
    expect(row).toHaveClass("h-tabstrip", "shrink-0", "items-center", "justify-between", "px-2");
    expect(row.className).not.toMatch(/\bborder-b\b/);
  });

  it("keeps today's order and titles: engine picker, model chip, then New conversation", async () => {
    useAiStore.setState({ pendingEngineModel: "claude-opus-4" });
    await renderPanel();
    const titles = headerButtons().map((b) => b.getAttribute("title"));
    expect(titles).toEqual([SWITCH_TITLE, "Model: claude-opus-4 (click to change)", "New conversation"]);
    expect(screen.getByTitle(SWITCH_TITLE)).toHaveTextContent("Claude Code");
    expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
  });

  it("shows no model chip while no model is known", async () => {
    await renderPanel();
    expect(headerButtons().map((b) => b.getAttribute("title"))).toEqual([SWITCH_TITLE, "New conversation"]);
  });

  it("refetches the models when the model chip is clicked", async () => {
    const fetchEngineModels = vi.fn(async () => undefined);
    useAiStore.setState({ pendingEngineModel: "gpt-5", fetchEngineModels });
    await renderPanel();
    const chip = screen.getByTitle("Model: gpt-5 (click to change)");
    expect(chip).toHaveTextContent("gpt-5");
    fireEvent.click(chip);
    expect(fetchEngineModels).toHaveBeenCalledTimes(1);
  });

  it("starts a new conversation from the + button", async () => {
    const createEngineSession = vi.fn(async () => undefined);
    useAiStore.setState({ createEngineSession } as never);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await waitFor(() => expect(createEngineSession).toHaveBeenCalledTimes(1));
  });
});

describe("ChatPanel engine dropdown (spec 3.7)", () => {
  it("lists every engine in order under the picker, with the active engine's dot kept as text", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTitle(SWITCH_TITLE));
    const menu = within(header()).getByRole("menu");
    expect(menu.parentElement).toHaveClass("absolute", "top-full", "left-0", "mt-1", "min-w-[200px]", "max-h-72", "overflow-y-auto");

    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.replace("●", "").trim())).toEqual(ENGINE_TYPES.map((t) => getHarness(t).name));
    items.forEach((item) => expect(item.tagName).toBe("BUTTON"));

    const [active, ...rest] = items;
    expect(active).toHaveTextContent("Claude Code●");
    const dot = within(active).getByText("●");
    expect(dot).toHaveClass("text-link");
    rest.forEach((item) => expect(item.textContent).not.toContain("●"));
  });

  it("switches the engine in memory only and closes", async () => {
    await renderPanel();
    fireEvent.click(screen.getByTitle(SWITCH_TITLE));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Codex/ }));

    expect(useAiStore.getState().activeEngineType).toBe("codex");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("settings_save", expect.anything());
    expect(screen.getByTitle(SWITCH_TITLE)).toHaveTextContent("Codex");
  });

  it("toggles from the picker and closes on an outside mousedown", async () => {
    await renderPanel();
    const picker = screen.getByTitle(SWITCH_TITLE);
    fireEvent.click(picker);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(picker);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(picker);
    act(() => {
      fireEvent.mouseDown(document.body);
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the picker", async () => {
    await renderPanel();
    const picker = screen.getByTitle(SWITCH_TITLE);
    fireEvent.click(picker);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(picker).toHaveFocus();
  });
});
