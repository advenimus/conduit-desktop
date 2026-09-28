import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => undefined),
  listenSync: vi.fn(() => () => undefined),
}));

import ModelPicker from "../ModelPicker";
import { useAiStore } from "../../../stores/aiStore";

const initialState = useAiStore.getState();
const MODELS = [
  { id: "opus", name: "Opus", description: "Most capable" },
  { id: "sonnet", name: "Sonnet", description: "Balanced", isDefault: true },
  { id: "haiku", name: "Haiku" },
];

const selectEngineModel = vi.fn(async () => undefined);
const closeModelPicker = vi.fn();

function card(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-popover]");
  if (!el) throw new Error("no model picker card");
  return el;
}

beforeEach(() => {
  selectEngineModel.mockClear();
  closeModelPicker.mockClear();
  useAiStore.setState({
    ...initialState,
    engineModelOptions: MODELS,
    activeEngineSessionId: null,
    engineSessions: [],
    pendingEngineModel: "opus",
    selectEngineModel,
    closeModelPicker,
  });
});

afterEach(() => {
  useAiStore.setState(initialState, true);
});

describe("ModelPicker (spec 3.16)", () => {
  it("stays an in-flow card with its margins and takes the overlay look", () => {
    render(<ModelPicker />);
    const el = card();
    expect(el).toHaveClass("mx-4", "mb-4", "rounded-lg", "border-overlay-border", "bg-overlay");
    expect(el.className).not.toMatch(/\b(fixed|absolute)\b/);
    expect(el.className).not.toMatch(/bg-panel|border-stroke/);
  });

  it("keeps the header text and gives the close button a name", () => {
    render(<ModelPicker />);
    expect(screen.getByText("Select a model")).toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveAttribute("title", "Close");
    fireEvent.click(close);
    expect(closeModelPicker).toHaveBeenCalled();
  });

  it("lists the models in order as ListRow buttons with their descriptions, the current one selected", () => {
    render(<ModelPicker />);
    const rows = MODELS.map((m) => screen.getByText(m.name).closest("button") as HTMLButtonElement);
    expect(rows.every(Boolean)).toBe(true);
    const all = [...card().querySelectorAll("button")];
    expect(rows.map((r) => all.indexOf(r))).toEqual([...rows.map((r) => all.indexOf(r))].sort((a, b) => a - b));
    expect(within(rows[0]).getByText("Most capable")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Balanced")).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute("data-selected");
    expect(rows[0]).toHaveClass("bg-selected");
    expect(rows[0].querySelector("svg")).not.toBeNull();
    expect(rows[1]).not.toHaveAttribute("data-selected");
  });

  it("selects the default model when none is current", () => {
    useAiStore.setState({ pendingEngineModel: null });
    render(<ModelPicker />);
    expect(screen.getByText("Sonnet").closest("button")).toHaveAttribute("data-selected");
  });

  it("selects a model on click", () => {
    render(<ModelPicker />);
    fireEvent.click(screen.getByText("Haiku"));
    expect(selectEngineModel).toHaveBeenCalledWith("haiku");
  });

  it("keeps the custom model flow: its row, the field placeholder and Apply", () => {
    render(<ModelPicker />);
    fireEvent.click(screen.getByRole("button", { name: "Use custom model ID..." }));
    const field = screen.getByPlaceholderText("Enter model ID...");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    fireEvent.change(field, { target: { value: " my-model " } });
    fireEvent.click(apply);
    expect(selectEngineModel).toHaveBeenCalledWith("my-model");
  });

  it("closes on Escape", () => {
    render(<ModelPicker />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeModelPicker).toHaveBeenCalled();
  });

  it("shows the busy text while the models load", () => {
    useAiStore.setState({ engineModelOptions: [] });
    render(<ModelPicker />);
    expect(screen.getByText("Loading models...")).toBeVisible();
    expect(card()).toHaveClass("bg-overlay");
  });
});
