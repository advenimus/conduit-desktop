import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const toastError = vi.fn();
vi.mock("../../lib/electron", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../components/common/Toast", () => ({ toast: { error: (...a: unknown[]) => toastError(...a), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("../../components/sessions/TerminalView", () => ({ disposeTerminalEntry: vi.fn() }));

const { useEntryStore } = await import("../entryStore");

beforeEach(() => {
  invoke.mockReset();
  toastError.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("entry save errors", () => {
  it("a failed update (vault locked by a take-over) is shown, not swallowed", async () => {
    invoke.mockRejectedValue(new Error("Vault is locked"));
    await expect(useEntryStore.getState().updateEntry("e1", { name: "x" })).resolves.toBeNull();
    expect(toastError).toHaveBeenCalledWith("Couldn't save the entry");
  });

  it("a failed create is shown too", async () => {
    invoke.mockRejectedValue(new Error("Vault is locked"));
    await expect(useEntryStore.getState().createEntry({ name: "x", entry_type: "credential" } as never)).resolves.toBeNull();
    expect(toastError).toHaveBeenCalledWith("Couldn't create the entry");
  });
});

describe("folder save errors", () => {
  it("a failed folder create or rename is shown", async () => {
    invoke.mockRejectedValue(new Error("Vault is locked"));
    await expect(useEntryStore.getState().createFolder("x", null)).resolves.toBeNull();
    await expect(useEntryStore.getState().updateFolder("f1", { name: "y" })).resolves.toBeNull();
    expect(toastError.mock.calls.map((c) => c[0])).toEqual(["Couldn't create the folder", "Couldn't save the folder"]);
  });
});
