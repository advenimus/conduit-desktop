import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import SecurityTab from "../tabs/SecurityTab";
import { useVaultStore } from "../../../stores/vaultStore";
import type { StartupStatus } from "../../../stores/startupVaultStore";
import type { Settings } from "../SettingsHelpers";

const WORK = "/v/Work.conduit";
const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));
let current: StartupStatus;

function status(over: Partial<StartupStatus> = {}): StartupStatus {
  return { platform: "linux", store: { usable: true, reason: "ok", storeName: "system keyring" }, startupVault: null, savedPath: null, currentOn: false, ...over };
}

function renderTab() {
  return render(<SecurityTab settings={{ vault_idle_lock_minutes: 0 } as Settings} setSettings={vi.fn()} onClose={vi.fn()} />);
}

beforeEach(() => {
  current = status();
  invoke.mockImplementation(async (channel) => {
    if (channel === "auto_unlock_status" || channel === "auto_unlock_disable") return current;
    return false;
  });
  window.electron = { platform: "linux", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ vaultType: "personal", currentVaultPath: WORK, isUnlocked: true });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

const autoSwitch = () => screen.queryByRole("switch", { name: "Unlock automatically at startup" });

describe("Settings > Security > Automatic Unlock (docs/AUTO_UNLOCK.md 2.5)", () => {
  it("sits between Quick Unlock and Auto-lock, off, with the hint", async () => {
    renderTab();
    await nextTask();
    const headings = [...document.querySelectorAll("h2, h3")].map((h) => h.textContent);
    expect(headings.indexOf("Automatic Unlock")).toBeLessThan(headings.indexOf("Auto-lock"));
    expect(autoSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Open Work without the master password when Conduit starts")).toBeInTheDocument();
  });

  it("switching on opens the warning with the password proof; the switch stays off", async () => {
    renderTab();
    await nextTask();
    fireEvent.click(autoSwitch() as HTMLElement);
    expect(screen.getByRole("heading", { name: "Unlock Work automatically?" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Enter master password")).toBeInTheDocument();
    expect(autoSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("on: the short warning and the store line; switching off acts at once", async () => {
    current = status({ startupVault: { kind: "personal", path: WORK, lineageId: "L" }, savedPath: WORK, currentOn: true });
    renderTab();
    await nextTask();
    expect(screen.getByText(/Locking still asks for the password/)).toBeInTheDocument();
    expect(screen.getByText("Your master password is kept in the system keyring on this computer.")).toBeInTheDocument();
    fireEvent.click(autoSwitch() as HTMLElement);
    await nextTask();
    expect(invoke).toHaveBeenCalledWith("auto_unlock_disable", undefined);
  });

  it("names another vault that has it on", async () => {
    current = status({ savedPath: "/v/Home.conduit" });
    renderTab();
    await nextTask();
    expect(screen.getByText("Home unlocks automatically now. Turning this on moves it to Work.")).toBeInTheDocument();
  });

  it("a weak Linux keyring gets the notice with the open-lock icon, and no switch", async () => {
    current = status({ store: { usable: false, reason: "weak", storeName: "system keyring" } });
    renderTab();
    await nextTask();
    expect(screen.getByText(/needs a system keyring, such as GNOME Keyring or KWallet/)).toBeInTheDocument();
    expect(autoSwitch()).toBeNull();
  });

  it("a team vault gets the personal-vaults notice and a Turn Off link when a personal vault has it", async () => {
    useVaultStore.setState({ vaultType: "team" });
    current = status({ savedPath: "/v/Home.conduit" });
    renderTab();
    await nextTask();
    expect(screen.getByText(/Automatic unlock is for personal vaults/)).toBeInTheDocument();
    expect(screen.getByText(/Home unlocks automatically on this computer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn Off" })).toBeInTheDocument();
  });
});
