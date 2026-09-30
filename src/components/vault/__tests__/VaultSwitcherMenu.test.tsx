import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import VaultSwitcherMenu from "../VaultSwitcherMenu";
import { useVaultStore } from "../../../stores/vaultStore";
import { useAuthStore } from "../../../stores/authStore";
import { useTeamStore, type TeamVaultSummary } from "../../../stores/teamStore";
import { useStartupVaultStore, type StartupStatus } from "../../../stores/startupVaultStore";

const WORK = "/v/Work.conduit";
const OPS = { id: "t1", name: "Ops", description: null, member_count: 3 } as unknown as TeamVaultSummary;
const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));
let menuLabels: string[] = [];

function status(over: Partial<StartupStatus> = {}): StartupStatus {
  return { platform: "darwin", store: { usable: true, reason: "ok", storeName: "system keychain" }, startupVault: { kind: "personal", path: WORK, lineageId: "L1" }, savedPath: WORK, currentOn: true, ...over };
}

beforeEach(() => {
  menuLabels = [];
  invoke.mockImplementation(async (channel, args) => {
    if (channel === "show_context_menu_popup") {
      menuLabels = (args as { items: { label: string }[] }).items.map((i) => i.label).filter(Boolean);
      return null;
    }
    return undefined;
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ isUnlocked: true, currentVaultPath: WORK, recentVaults: [WORK], vaultType: "personal", teamVaultId: null, isNetworkVault: false });
  useAuthStore.setState({ authMode: "authenticated", isTeamMember: true });
  useTeamStore.setState({ teamVaults: [OPS], myRole: "member", team: { id: "team" } as never });
  useStartupVaultStore.setState({ status: status() });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const menu = () => <VaultSwitcherMenu onClose={vi.fn()} onNeedDeviceSetup={vi.fn()} onTeamVaultUnlock={vi.fn()} />;

describe("VaultSwitcherMenu right-click (docs/AUTO_UNLOCK.md 2.6)", () => {
  it("the current vault's row has the same startup menu as the Hub", async () => {
    render(menu());
    fireEvent.contextMenu(screen.getByRole("menuitem", { name: /Work/ }));
    await nextTask();
    expect(menuLabels).toEqual(["Stop Opening at Startup", "Turn Off Automatic Unlock", "Remove from Recents", "Copy Path"]);
  });

  it("team rows offer Open at Startup", async () => {
    render(menu());
    fireEvent.contextMenu(screen.getByRole("menuitem", { name: /Ops/ }));
    await nextTask();
    expect(menuLabels).toEqual(["Open at Startup"]);
  });
});
