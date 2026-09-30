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
    ownership: null,
    deviceCap: null,
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

describe("SyncBanner markup (spec 3.8)", () => {
  function bannerOf(text: string | RegExp): HTMLElement {
    return screen.getByText(text).closest('[role="status"]') as HTMLElement;
  }

  it("keeps role=status, the text in span.flex-1 with data-cv-banner-text, and its actions as buttons", () => {
    useSyncStore.setState({ state: { ...stateWith([]), status: { ...stateWith([]).status!, conflictCount: 1 } } });
    render(<SyncBanners />);
    const banner = bannerOf("1 change from your other devices needs review.");
    expect(banner).not.toBeNull();
    const text = banner.querySelector("span.flex-1") as HTMLElement;
    expect(text.hasAttribute("data-cv-banner-text")).toBe(true);
    expect(text.textContent).toBe("1 change from your other devices needs review.");
    const buttons = [...banner.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Review", "Later"]);
    expect(buttons.map((b) => b.getAttribute("type"))).toEqual(["button", "button"]);
  });

  it("draws the primary action filled and the others secondary", () => {
    useSyncStore.setState({ state: { ...stateWith([]), status: { ...stateWith([]).status!, conflictCount: 2 } } });
    render(<SyncBanners />);
    const review = screen.getByRole("button", { name: "Review" });
    const later = screen.getByRole("button", { name: "Later" });
    expect(review.className).toContain("bg-btn-primary");
    expect(later.className).not.toContain("bg-btn-primary");
    expect(later.className).toContain("--c-btn-secondary-bg");
    expect(bannerOf(/2 changes from your other devices need review/).className).toContain("bg-warning-bg");
  });

  it("keeps Use here instead as the primary action of the soft lock banner", () => {
    useVaultStore.setState({ lockedReason: "open_elsewhere" });
    render(<SyncBanners />);
    const banner = bannerOf("This vault is open on another device. Your open connections keep running.");
    expect([...banner.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Use here instead", "Close vault"]);
    expect(screen.getByRole("button", { name: "Use here instead" }).className).toContain("bg-btn-primary");
    expect(banner.className).toContain("bg-selected");
  });
});

describe("heldChangesText", () => {
  it("names only the parts that happened", () => {
    expect(heldChangesText(2, 1)).toBe("deleted 2 items and changed 1 item back");
    expect(heldChangesText(0, 1)).toBe("changed 1 item back");
    expect(heldChangesText(2, 0)).toBe("deleted 2 items");
  });
});
