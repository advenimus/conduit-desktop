import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Pair = { hook: string; legacy: string | null; probe?: string };
type Helpers = {
  usesHook(scope: ParentNode | null, pair: Pair): boolean;
  pickOne(scope: ParentNode | null, pair: Pair, legacyScope?: ParentNode | null): Element | null;
  pickAll(scope: ParentNode | null, pair: Pair): Element[];
};
// The harness is plain .mjs without type declarations.
const { SELECTORS: S, helpers: cv } = (await import("../../../../scripts/verify/lib/selectors.mjs" as string)) as {
  SELECTORS: Record<string, Pair>;
  helpers: Helpers;
};

const sync = vi.hoisted(() => ({
  state: null as unknown,
  refresh: vi.fn(async () => {}),
  syncNow: vi.fn(async () => {}),
  openView: vi.fn(),
}));

vi.mock("../../../stores/syncStore", () => {
  const useSyncStore = (select: (s: unknown) => unknown) => select({ state: sync.state });
  useSyncStore.getState = () => ({ state: sync.state, refresh: sync.refresh, syncNow: sync.syncNow, openView: sync.openView });
  return { useSyncStore };
});
vi.mock("../../../stores/vaultStore", () => ({ useVaultStore: (select: (s: unknown) => unknown) => select({ vaultType: "personal" }) }));
vi.mock("../../../stores/tierStore", () => ({ useTierStore: (select: (s: unknown) => unknown) => select({ maxOpenDevices: 1 }) }));
vi.mock("../../sync/SyncDevicesList", () => ({ default: () => <div>devices</div> }));
vi.mock("../../sync/SyncNoticeList", () => ({ default: () => null }));

import SyncTab from "../tabs/SyncTab";

function syncState(killSwitch: boolean) {
  return {
    softLocked: false,
    killSwitch,
    deviceLimit: null,
    vault: { shared: false },
    status: { kind: "up-to-date", lastSyncedMs: Date.now() - 4000, conflictCount: 2, sessionBadge: null, prompts: [] },
  };
}

function root(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-cv-settings]")!;
}

beforeEach(() => {
  sync.state = syncState(false);
});

describe("Settings > Sync hooks (B4, B7, B36, B37)", () => {
  it("names its sections with h3 and exposes status, detail and plan through their hooks", () => {
    render(<div data-cv-settings=""><SyncTab /></div>);
    expect([...root().querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Multi-device sync", "This vault", "Devices"]);

    const status = cv.pickOne(root(), S.syncStatus);
    expect(status).toHaveAttribute("data-cv-sync-status");
    expect(cv.pickOne(status, S.syncStatusLabel)?.textContent).toBe("Up to date");
    expect(cv.pickOne(status, S.syncStatusDetail)?.textContent).toMatch(/^Last synced /);
    expect(cv.usesHook(root(), S.syncPlan)).toBe(true);
    expect(cv.pickAll(root(), S.syncPlan)[0]?.textContent).toMatch(/^Your plan: a vault can be open on one device at a time\./);
    expect(cv.pickAll(root(), S.syncPaused)).toHaveLength(0);
  });

  it("keeps the button texts the flows click", () => {
    render(<div data-cv-settings=""><SyncTab /></div>);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review changes (2)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recently deleted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Other copies" })).toBeInTheDocument();
  });

  it("marks the paused note while the kill switch is on", () => {
    sync.state = syncState(true);
    render(<div data-cv-settings=""><SyncTab /></div>);
    const paused = cv.pickAll(root(), S.syncPaused);
    expect(paused.map((p) => p.textContent)).toEqual(["Conduit paused syncing for now. Your changes are saved on this device."]);
    expect(paused[0].className).toContain("text-warning");
  });
});
