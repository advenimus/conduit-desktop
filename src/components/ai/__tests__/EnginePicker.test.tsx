import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/electron", () => ({
  invoke,
  listen: vi.fn(async () => () => undefined),
  listenSync: vi.fn(() => () => undefined),
}));

import EnginePicker from "../EnginePicker";
import { useAiStore } from "../../../stores/aiStore";
import { AI_HARNESSES } from "../../../lib/ai-harnesses";

const initialState = useAiStore.getState();
const checkEngineAvailability = vi.fn(async () => undefined);
const [installed, missing] = AI_HARNESSES;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => (channel === "settings_get" ? { theme: "dark" } : null));
  checkEngineAvailability.mockClear();
  useAiStore.setState({
    ...initialState,
    activeEngineType: installed.id,
    engineAvailability: Object.fromEntries(AI_HARNESSES.map((h) => [h.id, h.id === installed.id])) as never,
    checkEngineAvailability,
  });
});

afterEach(() => {
  useAiStore.setState(initialState, true);
});

describe("EnginePicker", () => {
  it("keeps its texts and one card per agent, in order", () => {
    render(<EnginePicker onPick={() => {}} />);
    expect(screen.getByText("Choose your AI agent")).toBeInTheDocument();
    expect(screen.getByText(/Conduit uses your local CLI agent\./)).toBeInTheDocument();
    const names = AI_HARNESSES.map((h) => screen.getByText(h.name));
    for (let i = 1; i < names.length; i++) {
      expect(names[i - 1].compareDocumentPosition(names[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(checkEngineAvailability).toHaveBeenCalled();
  });

  it("shows availability as badges and the matching action", () => {
    render(<EnginePicker onPick={() => {}} />);
    expect(screen.getByText("Installed")).toHaveClass("text-success");
    expect(screen.getAllByText("Not installed")[0]).toHaveClass("text-warning");
    expect(screen.getByRole("button", { name: `Use ${installed.name}` })).toHaveClass("bg-btn-primary");
    expect(screen.getAllByRole("button", { name: "Install instructions" })).toHaveLength(AI_HARNESSES.length - 1);
  });

  it("marks the last chosen agent's card with the accent border", () => {
    render(<EnginePicker onPick={() => {}} />);
    const card = screen.getByText(installed.name).closest(".rounded-md.border") as HTMLElement;
    expect(card).toHaveClass("border-accent");
    const other = screen.getByText(missing.name).closest(".rounded-md.border") as HTMLElement;
    expect(other).toHaveClass("border-card-border");
  });

  it("saves the choice, keeps Starting… visible while busy, then calls onPick", async () => {
    let finish: () => void = () => undefined;
    const onPick = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<EnginePicker onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: `Use ${installed.name}` }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(installed.id));
    expect(invoke).toHaveBeenCalledWith("settings_save", {
      settings: { theme: "dark", default_engine: installed.id, engine_picker_completed: true },
    });
    const busy = screen.getByRole("button", { name: "Starting…" });
    expect(busy).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByRole("button", { name: `Use ${installed.name}` })).toBeEnabled();
  });

  it("shows a failed save as danger text", async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings_get") throw new Error("disk full");
      return null;
    });
    render(<EnginePicker onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: `Use ${installed.name}` }));
    expect(await screen.findByText("disk full")).toHaveClass("text-danger");
  });

  it("opens install docs and re-checks availability", async () => {
    render(<EnginePicker onPick={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Install instructions" })[0]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("engine_open_install_docs", { engineType: missing.id }));
    checkEngineAvailability.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Re-check availability" }));
    expect(checkEngineAvailability).toHaveBeenCalled();
  });
});
