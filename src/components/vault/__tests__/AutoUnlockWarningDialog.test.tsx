import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import AutoUnlockWarningDialog, { replacementLine } from "../AutoUnlockWarningDialog";
import { useVaultStore } from "../../../stores/vaultStore";
import { useStartupVaultStore, type StartupStatus } from "../../../stores/startupVaultStore";
import { useAuthStore } from "../../../stores/authStore";
import { AUTO_UNLOCK_WARNING } from "../../../lib/startup-vault-copy";

const VAULT = "/v/Work.conduit";
const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

function status(over: Partial<StartupStatus> = {}): StartupStatus {
  return { platform: "darwin", store: { usable: true, reason: "ok", storeName: "system keychain" }, startupVault: null, savedPath: null, currentOn: false, ...over };
}

beforeEach(() => {
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ currentVaultPath: VAULT, biometricAvailable: false, biometricEnabled: false });
  useStartupVaultStore.setState({ status: status() });
  useAuthStore.setState({ isTeamMember: false });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("AutoUnlockWarningDialog (docs/AUTO_UNLOCK.md 2.2)", () => {
  it("shows the exact warning, the store and the replacement line", () => {
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Unlock Work automatically?" })).toBeInTheDocument();
    expect(screen.getByText(AUTO_UNLOCK_WARNING)).toBeInTheDocument();
    expect(screen.getByText(/keep the master password for Work.conduit in the system keychain/)).toBeInTheDocument();
    expect(screen.getByText("Conduit will open Work instead of the Vault Hub.")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Enter master password")).toBeNull();
  });

  it("has a replacement line for every prior choice, and none for this vault", () => {
    const base = { currentPath: VAULT, name: "Work", isTeamMember: false, teamName: () => "Ops" };
    expect(replacementLine({ ...base, startup: null, isTeamMember: true })).toBe("Conduit will open Work instead of your last team vault.");
    expect(replacementLine({ ...base, startup: { kind: "hub" } })).toBe("Conduit will open Work instead of the Vault Hub.");
    expect(replacementLine({ ...base, startup: { kind: "personal", path: "/v/Home.conduit", lineageId: null } })).toBe("Conduit will open Work instead of Home.conduit.");
    expect(replacementLine({ ...base, startup: { kind: "team", teamVaultId: "t" } })).toBe("Conduit will open Work instead of the team vault Ops.");
    expect(replacementLine({ ...base, startup: { kind: "personal", path: VAULT, lineageId: "L" } })).toBeNull();
  });

  it("from Settings needs the password, and a wrong one shows the message", async () => {
    invoke.mockRejectedValue(new Error("That password didn't work."));
    const onClose = vi.fn();
    render(<AutoUnlockWarningDialog mode="settings" onClose={onClose} />);
    const turnOn = screen.getByRole("button", { name: "Turn On" });
    expect(turnOn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Enter master password"), { target: { value: "nope" } });
    fireEvent.click(turnOn);
    await nextTask();
    expect(invoke).toHaveBeenCalledWith("auto_unlock_enable", { proof: { kind: "password", password: "nope" } });
    expect(document.querySelector("[data-cv-error]")).toHaveTextContent("That password didn't work.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers Use Touch ID Instead only on a Mac with Touch ID", () => {
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Use Touch ID Instead" })).toBeNull();
    cleanup();
    useVaultStore.setState({ biometricAvailable: true });
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Use Touch ID Instead" })).toBeInTheDocument();
    cleanup();
    useStartupVaultStore.setState({ status: status({ platform: "win32" }) });
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Use Touch ID Instead" })).toBeNull();
  });

  it("Escape acts as Cancel", () => {
    const onClose = vi.fn();
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={onClose} />);
    fireEvent.keyDown(document.querySelector("[data-dialog-content]") as HTMLElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
