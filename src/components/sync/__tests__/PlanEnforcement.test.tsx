import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { displacedCopy } from "../DisplacedDialog";
import TakeoverDialog from "../TakeoverDialog";
import NotOwnerDialog from "../NotOwnerDialog";
import SignInRequiredDialog from "../SignInRequiredDialog";
import UpdateRequiredDialog from "../UpdateRequiredDialog";
import SessionConflictDialog from "../SessionConflictDialog";
import SyncBanners from "../SyncBanners";
import { deviceCapText, ownerLineText } from "../sync-copy";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useAuthStore } from "../../../stores/authStore";
import type { DisplacedEvent, OpenErrorPayload, SyncStateResponse, TakeoverHolder, VaultOwnership } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

const holder = (name: string, over: Partial<TakeoverHolder> = {}): TakeoverHolder => ({
  deviceId: `d-${name}`,
  deviceName: name,
  platform: "macos",
  fileName: null,
  fileId: null,
  location: null,
  lastActiveMs: null,
  busySessions: 0,
  busyJobs: 0,
  ...over,
});

function displaced(over: Partial<DisplacedEvent>): DisplacedEvent {
  return { lineageId: "L", reason: "takeover", byDeviceName: "iPhone", openConnections: 0, runningJobs: 0, changesSaved: true, fileName: null, minVersion: null, released: false, deviceCap: null, ...over };
}

type OpenElsewhere = Extract<OpenErrorPayload, { code: "VAULT_OPEN_ELSEWHERE" }>;
type NotOwner = Extract<OpenErrorPayload, { code: "VAULT_NOT_OWNER" }>;

function elsewhere(over: Partial<OpenElsewhere>): OpenElsewhere {
  return { code: "VAULT_OPEN_ELSEWHERE", holders: [holder("MacBook")], limit: 1, fileName: "Vault", locationDiffers: false, via: "server", cause: "vault_limit", deviceCap: 5, displaceDeviceName: null, alsoLockDeviceName: null, ...over };
}

function notOwner(over: Partial<NotOwner> = {}): NotOwner {
  return { code: "VAULT_NOT_OWNER", fileName: "Vault.conduit", offline: false, graceEndedMs: null, released: false, copyTicket: "ticket-1", copyDir: "/cloud", ...over };
}

function stateWith(ownership: VaultOwnership | null): SyncStateResponse {
  return {
    enabled: true,
    killSwitch: false,
    vault: { lineageId: "L", path: "/cloud/Vault.conduit", fileName: "Vault.conduit", shared: true, engine: true },
    status: null,
    deviceLimit: null,
    sideFiles: [],
    notices: [],
    pendingVaults: [],
    softLocked: false,
    ownership,
    deviceCap: 5,
  };
}

beforeEach(() => {
  invoke.mockResolvedValue(null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  window.localStorage.clear();
  useVaultStore.setState({ lockedReason: null, isUnlocked: true, vaultType: "personal", currentVaultPath: "/cloud/Vault.conduit" });
  useAuthStore.setState({ user: { id: "u1", email: "me@example.com" } as never, isAuthenticated: true });
  useSyncStore.setState({ state: null, releaseDialogOpen: false });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("displacedCopy (S2, S8, S8b, S10)", () => {
  it("device cap names the new device and the cap, with [Use here instead]", () => {
    expect(displacedCopy(displaced({ reason: "device_cap", byDeviceName: "Work PC", deviceCap: 5 }))).toEqual({
      title: "Vault locked",
      body: "You opened Conduit on Work PC. Your plan allows 5 devices at once, so your vaults locked here.",
      upgrade: false,
      useHere: true,
    });
    expect(displacedCopy(displaced({ reason: "device_cap", byDeviceName: null, deviceCap: 3 })).body).toBe(
      "You opened Conduit on another device. Your plan allows 3 devices at once, so your vaults locked here.",
    );
  });

  it("not owner (S8, S8b) and update required (S10) never offer [Use here instead]", () => {
    expect(displacedCopy(displaced({ reason: "not_owner" }))).toMatchObject({
      body: "This vault belongs to another Conduit account, and your 14 days of access ended. Unlock it again to make your own copy.",
      useHere: false,
    });
    expect(displacedCopy(displaced({ reason: "not_owner", released: true })).body).toBe(
      "You released this vault and another account now owns it. Unlock it again to make your own copy.",
    );
    expect(displacedCopy(displaced({ reason: "update_required", minVersion: "0.19.0" }))).toMatchObject({
      title: "Vault locked",
      body: "Update Conduit to keep using this vault.",
      useHere: false,
      update: true,
    });
  });
});

describe("TakeoverDialog", () => {
  it("S1: too many devices lists each device with its vaults and the one that locks", () => {
    const payload = elsewhere({ cause: "device_cap", limit: -1, holders: [holder("Old PC", { vaults: 2 }), holder("iPad", { vaults: 1 })], displaceDeviceName: "Old PC" });
    render(<TakeoverDialog payload={payload} busy={false} onUseHere={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Too many devices" })).toBeInTheDocument();
    expect(screen.getByText("You're using Conduit on 5 devices. Close one to use it here.")).toBeInTheDocument();
    expect(screen.getByText("Old PC: 2 vaults open")).toBeInTheDocument();
    expect(screen.getByText("Conduit will lock your vaults on Old PC, the one you used least recently.")).toBeInTheDocument();
    expect(screen.queryByText("Upgrade to Pro")).toBeNull();
  });

  it("S1b: the Free take-over also names the device the cap locks", () => {
    render(<TakeoverDialog payload={elsewhere({ alsoLockDeviceName: "Old PC" })} busy={false} onUseHere={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Conduit will also lock your vaults on Old PC, because you're using Conduit on 5 devices.")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Vault open on another device" })).toBeInTheDocument();
  });
});

describe("NotOwnerDialog (S4, S5)", () => {
  it("S4: email, every button, and [Make my own copy] opens the Save dialog in the original's folder", async () => {
    invoke.mockImplementation(async (channel: string) => (channel === "vault_pick_file" ? "/cloud/Mine.conduit" : channel === "sync_make_own_copy" ? { path: "/cloud/Mine.conduit", lineageId: "N" } : null));
    const onCancel = vi.fn();
    render(<NotOwnerDialog payload={notOwner()} onCancel={onCancel} />);
    expect(screen.getByRole("dialog", { name: "This vault belongs to another account" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "This vault, or the file it was copied from, belongs to another Conduit account. Make your own copy to keep using this data, or ask the owner to share it with you in a Team vault.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("You're signed in as me@example.com. If this is your vault, sign in with the account you use on your other devices.")).toBeInTheDocument();
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Open a vault...", "Switch account", "Try Team free", "Cancel", "Make my own copy"]));
    fireEvent.click(screen.getByText("Make my own copy"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_make_own_copy", { ticket: "ticket-1", targetPath: "/cloud/Mine.conduit" }));
    expect(invoke).toHaveBeenCalledWith("vault_pick_file", { mode: "save", defaultDir: "/cloud" });
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("[Try Team free] opens the trial link; S8b body when this account released the vault", () => {
    render(<NotOwnerDialog payload={notOwner({ released: true })} onCancel={vi.fn()} />);
    expect(screen.getByText("You released this vault and another account now owns it. Unlock it again to make your own copy.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Try Team free"));
    expect(invoke).toHaveBeenCalledWith("auth_open_team_trial", undefined);
  });

  it("S5 offline: only [OK]", () => {
    const onCancel = vi.fn();
    render(<NotOwnerDialog payload={notOwner({ offline: true, copyTicket: null })} onCancel={onCancel} />);
    expect(screen.getByText("Connect to the internet so Conduit can check who owns this vault, then try again.")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["OK"]);
    fireEvent.click(screen.getByText("OK"));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("S6, S9, S3", () => {
  it("S6 sign in", () => {
    render(<SignInRequiredDialog onCancel={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Sign in to open this vault" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Sign in"));
    expect(useAuthStore.getState().authMode).toBeNull();
  });

  it("S9 update: no update found opens the download page", async () => {
    render(<UpdateRequiredDialog minVersion="0.19.0" onCancel={vi.fn()} />);
    expect(screen.getByText("This version of Conduit can't open your vaults anymore. Update to version 0.19.0 or later.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Update Conduit"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("auth_open_download", undefined));
    expect(invoke).toHaveBeenCalledWith("force_check_for_updates", undefined);
  });

  it("S3 device-cap reconnect", () => {
    render(<SessionConflictDialog event={{ lineageId: "L", holders: [holder("Old PC")], answerByMs: Date.now() + 30_000, cause: "device_cap", deviceCap: 5 }} />);
    expect(screen.getByRole("dialog", { name: "Too many devices" })).toBeInTheDocument();
    expect(screen.getByText("Using it here locks your vaults on Old PC.")).toBeInTheDocument();
    expect(screen.getByText("Lock here")).toBeInTheDocument();
  });
});

describe("banners (S7, S7b, S21, S22)", () => {
  it("S7 grace: date, email and the four actions", () => {
    const until = new Date(2026, 9, 13).getTime();
    useSyncStore.setState({ state: stateWith({ kind: "grace", untilMs: until }) });
    render(<SyncBanners />);
    const text = screen.getByText(/belongs to another Conduit account\. You can use it until/);
    expect(text.textContent).toContain("The owner can move it into a Team vault and invite you. Signed in as me@example.com.");
    const banner = text.closest('[role="status"]') as HTMLElement;
    expect([...banner.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Switch account", "Later", "Try Team free", "Make my own copy"]);
  });

  it("a private vault (no engine) gets no [Make my own copy] while open", () => {
    const state = stateWith({ kind: "grace", untilMs: Date.now() + 1_000_000 });
    useSyncStore.setState({ state: { ...state, vault: { ...state.vault!, shared: false, engine: false } } });
    render(<SyncBanners />);
    expect(screen.queryByText("Make my own copy")).toBeNull();
    expect(screen.getByText("Try Team free")).toBeInTheDocument();
  });

  it("[Later] hides the grace banner for the day", () => {
    useSyncStore.setState({ state: stateWith({ kind: "grace", untilMs: Date.now() + 1_000_000 }) });
    const { rerender } = render(<SyncBanners />);
    fireEvent.click(screen.getByText("Later"));
    rerender(<SyncBanners />);
    expect(screen.queryByText(/You can use it until/)).toBeNull();
  });

  it("S7b owner: release opens S12 and is disabled during the cooldown", () => {
    useSyncStore.setState({ state: stateWith({ kind: "owner", releaseAfterMs: null, sharedUntilMs: Date.now() + 86_400_000 }) });
    render(<SyncBanners />);
    expect(screen.getByText(/Another Conduit account is using this vault until/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Release this vault..."));
    expect(useSyncStore.getState().releaseDialogOpen).toBe(true);
    cleanup();
    useSyncStore.setState({ state: stateWith({ kind: "owner", releaseAfterMs: Date.now() + 86_400_000, sharedUntilMs: Date.now() + 86_400_000 }) });
    render(<SyncBanners />);
    expect(screen.getByText("Release this vault...")).toBeDisabled();
  });

  it("S21 and S22 soft-lock banners", () => {
    useVaultStore.setState({ lockedReason: "not_owner" });
    const { rerender } = render(<SyncBanners />);
    expect(screen.getByText("This vault belongs to another Conduit account. Your open connections keep running.")).toBeInTheDocument();
    useVaultStore.setState({ lockedReason: "update_required" });
    rerender(<SyncBanners />);
    expect(screen.getByText("Update Conduit to use this vault. Your open connections keep running.")).toBeInTheDocument();
    expect(screen.getByText("Update Conduit")).toBeInTheDocument();
  });
});

describe("Sync settings copy (S11)", () => {
  it("owner lines and the device cap sentence", () => {
    expect(ownerLineText({ kind: "owner", releaseAfterMs: null, sharedUntilMs: null })).toBe("Owner: this account.");
    expect(ownerLineText({ kind: "unowned" })).toBe("Owner: not set yet.");
    expect(ownerLineText({ kind: "unknown" })).toBe("Owner: sign in to check.");
    expect(ownerLineText({ kind: "grace", untilMs: new Date(2026, 9, 13).getTime() })).toMatch(/^Owner: another account\. You can use it until .+\.$/);
    expect(ownerLineText(null)).toBeNull();
    expect(deviceCapText(5)).toBe("Up to 5 devices at once across your vaults.");
    expect(deviceCapText(-1)).toBeNull();
  });
});
