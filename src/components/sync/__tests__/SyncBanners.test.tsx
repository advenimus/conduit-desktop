import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SyncBanners from "../SyncBanners";
import { heldChangesText } from "../PromptBanner";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";
import type { SyncPrompt, SyncStateResponse } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

function stateWith(prompts: readonly SyncPrompt[]): SyncStateResponse {
  return {
    enabled: true,
    killSwitch: false,
    vault: { lineageId: "L", path: "/cloud/Vault.conduit", fileName: "Vault.conduit", shared: true, engine: true },
    status: {
      lineageId: "L",
      fileName: "Vault.conduit",
      kind: "paused",
      pauseReason: null,
      waiting: null,
      pendingPublish: false,
      unsyncedOps: 0,
      conflictCount: 0,
      lastSyncedMs: null,
      backoffUntilMs: null,
      sessionBadge: null,
      networkRoot: false,
      prompts,
      otherCopies: [],
    },
    deviceLimit: null,
    sideFiles: [],
    notices: [],
    pendingVaults: [],
    softLocked: false,
  };
}

beforeEach(() => {
  invoke.mockResolvedValue(null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ lockedReason: null });
  useSyncStore.setState({ deferredPrompts: new Set(), reviewBannerClosedFor: null, openWaiting: null });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("SyncBanners", () => {
  it("[Keep working on this device] keeps the banner away although the engine raises it again", () => {
    const missing: SyncPrompt = { kind: "file-missing", id: "file-missing", path: "/cloud/Vault.conduit" };
    useSyncStore.setState({ state: stateWith([missing]) });
    const { rerender } = render(<SyncBanners />);
    fireEvent.click(screen.getByText("Keep working on this device"));
    useSyncStore.setState({ state: stateWith([missing]) });
    rerender(<SyncBanners />);
    expect(screen.queryByText(/Vault file not found/)).toBeNull();
  });

  it("a password prompt put off with [Later] stays reachable from a banner", () => {
    const epoch: SyncPrompt = { kind: "epoch-newer", id: "epoch-1", changedByDeviceName: "iPhone", changedMs: 1 };
    useSyncStore.setState({ state: stateWith([epoch]), deferredPrompts: new Set(["epoch-1"]) });
    render(<SyncBanners />);
    fireEvent.click(screen.getByText("Enter password"));
    expect(useSyncStore.getState().deferredPrompts.has("epoch-1")).toBe(false);
  });
});

describe("heldChangesText", () => {
  it("names only the parts that happened", () => {
    expect(heldChangesText(2, 1)).toBe("deleted 2 items and changed 1 item back");
    expect(heldChangesText(0, 1)).toBe("changed 1 item back");
    expect(heldChangesText(2, 0)).toBe("deleted 2 items");
  });
});
