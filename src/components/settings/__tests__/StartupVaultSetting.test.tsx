import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import StartupVaultSetting, { personalLabels, startupValue } from "../tabs/StartupVaultSetting";
import { useVaultStore } from "../../../stores/vaultStore";
import { useTeamStore, type TeamVaultSummary } from "../../../stores/teamStore";
import { useAuthStore } from "../../../stores/authStore";
import type { StartupStatus } from "../../../stores/startupVaultStore";

const WORK = "/v/Work.conduit";
const HOME = "/v/Home.conduit";
const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));
let current: StartupStatus;

function status(over: Partial<StartupStatus> = {}): StartupStatus {
  return { platform: "darwin", store: { usable: true, reason: "ok", storeName: "system keychain" }, startupVault: null, savedPath: null, currentOn: false, ...over };
}

beforeEach(() => {
  current = status();
  invoke.mockImplementation(async (channel, args) => {
    if (channel === "auto_unlock_status") return current;
    if (channel === "startup_vault_set") return { status: current, forgot: (args as { kind: string }).kind !== "personal" };
    return undefined;
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ recentVaults: [WORK, HOME] });
  useTeamStore.setState({ teamVaults: [{ id: "t1", name: "Ops" } as TeamVaultSummary] });
  useAuthStore.setState({ isTeamMember: false, authMode: "authenticated" });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const select = () => screen.getByRole("combobox", { name: "Open at startup" }) as HTMLSelectElement;
const options = () => [...select().querySelectorAll("option")].map((o) => o.textContent);

describe("Settings > General > Startup (docs/AUTO_UNLOCK.md 2.4)", () => {
  it("offers the hub and personal vaults to users who are not team members", async () => {
    render(<StartupVaultSetting />);
    await nextTask();
    expect(options()).toEqual(["Vault Hub", "Work", "Home"]);
    expect(select().value).toBe("hub");
    expect(screen.getByText("Shift")).toBeInTheDocument();
    expect(screen.getByText("Option")).toBeInTheDocument();
  });

  it("team members get Last team vault used first, and the team vaults", async () => {
    useAuthStore.setState({ isTeamMember: true });
    render(<StartupVaultSetting />);
    await nextTask();
    expect(options()).toEqual(["Last team vault used", "Vault Hub", "Work", "Home", "Ops"]);
    expect(select().value).toBe("automatic");
    expect(screen.getByText(/reconnects to the team vault you used last/)).toBeInTheDocument();
  });

  it("acts at once through startup_vault_set", async () => {
    render(<StartupVaultSetting />);
    await nextTask();
    fireEvent.change(select(), { target: { value: `p:${HOME}` } });
    await nextTask();
    expect(invoke).toHaveBeenCalledWith("startup_vault_set", { kind: "personal", path: HOME });
  });

  it("asks before choosing another vault while one unlocks automatically", async () => {
    current = status({ startupVault: { kind: "personal", path: WORK, lineageId: "L" }, savedPath: WORK });
    const onOpenSecurity = vi.fn();
    render(<StartupVaultSetting onOpenSecurity={onOpenSecurity} />);
    await nextTask();
    expect(screen.getByText(/Unlocks automatically on this computer/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(onOpenSecurity).toHaveBeenCalled();
    fireEvent.change(select(), { target: { value: "hub" } });
    await nextTask();
    expect(screen.getByRole("heading", { name: "Turn off automatic unlock?" })).toBeInTheDocument();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("startup_vault_set");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await nextTask();
    expect(invoke).toHaveBeenCalledWith("startup_vault_set", { kind: "hub" });
  });

  it("labels and values", () => {
    expect(personalLabels(["/a/Work.conduit", "/b/Work.conduit", "/b/Home.conduit"])).toEqual(
      new Map([["/a/Work.conduit", "Work (a)"], ["/b/Work.conduit", "Work (b)"], ["/b/Home.conduit", "Home"]]),
    );
    expect(startupValue(null, true)).toBe("automatic");
    expect(startupValue(null, false)).toBe("hub");
    expect(startupValue({ kind: "team", teamVaultId: "t" }, true)).toBe("t:t");
  });
});
