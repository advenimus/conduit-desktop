import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CustomizeMenu from "../CustomizeMenu";
import { resetHomeSettings } from "../useHomeSettings";
import { dashboardApi } from "../../../../lib/dashboardApi";
import { toast } from "../../../common/Toast";

const invoke = vi.hoisted(() => {
  const fn = vi.fn(async (_channel: string, _args?: unknown): Promise<unknown> => null);
  Object.assign(globalThis, { electron: { invoke: fn, on: () => () => undefined } });
  return fn;
});
vi.mock("../../../../lib/dashboardApi", () => ({ dashboardApi: { historyClear: vi.fn() } }));
vi.mock("../../../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const clear = vi.mocked(dashboardApi.historyClear);

function openMenu(onHistoryCleared = vi.fn()) {
  render(<CustomizeMenu onHistoryCleared={onHistoryCleared} />);
  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  return { onHistoryCleared, panel: () => screen.getByLabelText("Customize Home", { selector: "div" }) };
}

const lastSaved = () => {
  const call = [...invoke.mock.calls].reverse().find(([channel]) => channel === "ui_state_set");
  return (call?.[1] as { value: unknown } | undefined)?.value;
};

beforeEach(() => {
  resetHomeSettings();
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  clear.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
});

afterEach(() => resetHomeSettings());

describe("CustomizeMenu", () => {
  it("lists the sections and both thresholds", async () => {
    const { panel } = openMenu();
    const p = panel();
    expect(within(p).getByText("Customize Home")).toHaveClass("text-label", "font-semibold", "text-ink");
    expect(within(p).getByText("Show on Home")).toBeInTheDocument();
    expect(within(p).getByText("Needs attention", { selector: "p" })).toBeInTheDocument();
    const boxes = within(p).getAllByRole("checkbox");
    expect(boxes.map((b) => b.closest("label")!.textContent)).toEqual([
      "Search and quick actions",
      "Recently connected",
      "Open now",
      "Favorites",
      "Needs attention",
      "AI activity",
      "Vault status",
    ]);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    const passwords = within(p).getByLabelText("Warn about passwords older than") as HTMLSelectElement;
    expect([...passwords.options].map((o) => o.text)).toEqual(["90 days", "180 days", "1 year", "Never"]);
    expect(passwords.value).toBe("180");
    const backups = within(p).getByLabelText("Warn about backups older than") as HTMLSelectElement;
    expect([...backups.options].map((o) => o.text)).toEqual(["3 days", "7 days", "14 days", "30 days"]);
    expect(backups.value).toBe("7");
  });

  it("saves each change at once through ui_state_set", async () => {
    const { panel } = openMenu();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("ui_state_get", { key: "home-dashboard" }));
    const p = panel();
    fireEvent.click(within(p).getByLabelText("AI activity"));
    expect(lastSaved()).toEqual({ version: 1, hidden: ["ai-activity"], passwordAgeDays: 180, backupStaleDays: 7 });
    fireEvent.click(within(p).getByLabelText("Search and quick actions"));
    expect(lastSaved()).toMatchObject({ hidden: ["quick", "ai-activity"] });
    fireEvent.click(within(p).getByLabelText("AI activity"));
    expect(lastSaved()).toMatchObject({ hidden: ["quick"] });
    fireEvent.change(within(p).getByLabelText("Warn about passwords older than"), { target: { value: "never" } });
    expect(lastSaved()).toMatchObject({ passwordAgeDays: null });
    fireEvent.change(within(p).getByLabelText("Warn about passwords older than"), { target: { value: "365" } });
    expect(lastSaved()).toMatchObject({ passwordAgeDays: 365 });
    fireEvent.change(within(p).getByLabelText("Warn about backups older than"), { target: { value: "30" } });
    expect(lastSaved()).toEqual({ version: 1, hidden: ["quick"], passwordAgeDays: 365, backupStaleDays: 30 });
  });

  it("clears connection history after the confirm", async () => {
    clear.mockResolvedValue({ deleted: 4 });
    const { onHistoryCleared } = openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Clear connection history..." }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Clear connection history?")).toBeInTheDocument();
    expect(within(dialog).getByText("This removes the list of past connections for this vault on this device. Your entries do not change.")).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Clear history" });
    expect(confirm).toHaveClass("bg-btn-danger");
    fireEvent.click(confirm);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Connection history cleared"));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(onHistoryCleared).toHaveBeenCalledTimes(1);
  });

  it("cancel keeps the history; a failure says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clear.mockRejectedValue(new Error("locked"));
    const { onHistoryCleared } = openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Clear connection history..." }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Customize" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear connection history..." }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't clear the connection history"));
    expect(onHistoryCleared).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
