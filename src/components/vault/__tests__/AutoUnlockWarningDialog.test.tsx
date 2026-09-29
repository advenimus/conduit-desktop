import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import AutoUnlockWarningDialog, { replacementLine } from "../AutoUnlockWarningDialog";
import { useVaultStore } from "../../../stores/vaultStore";
import { useStartupVaultStore, type StartupStatus } from "../../../stores/startupVaultStore";
import { useAuthStore } from "../../../stores/authStore";
import { AUTO_UNLOCK_WARNING, PROOF_EXPIRED_MESSAGE } from "../../../lib/startup-vault-copy";

const toasts = vi.hoisted(() => [] as { type: string; title: string }[]);
vi.mock("../../common/Toast", () => {
  const add = (type: string) => (title: string) => {
    toasts.push({ type, title });
    return "id";
  };
  return { toast: { success: add("success"), info: add("info"), warning: add("warning"), error: add("error"), dismiss: vi.fn(), update: vi.fn() } };
});

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
  toasts.length = 0;
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

  it("after the unlock proof runs out, asks for the password in place instead of a dead end", async () => {
    invoke.mockRejectedValueOnce(new Error(PROOF_EXPIRED_MESSAGE)).mockResolvedValueOnce(status({ savedPath: VAULT, currentOn: true }));
    const onClose = vi.fn();
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn On" }));
    await nextTask();
    expect(invoke).toHaveBeenCalledWith("auto_unlock_enable", { proof: { kind: "recent-unlock" } });
    expect(document.querySelector("[data-cv-error]")).toBeNull();
    expect(screen.getByText(/Enter your master password to turn this on/)).toBeInTheDocument();
    const turnOn = screen.getByRole("button", { name: "Turn On" });
    expect(turnOn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Enter master password"), { target: { value: "pw" } });
    fireEvent.click(turnOn);
    await nextTask();
    expect(invoke).toHaveBeenLastCalledWith("auto_unlock_enable", { proof: { kind: "password", password: "pw" } });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("another error in after-unlock mode stays an error", async () => {
    invoke.mockRejectedValueOnce(new Error("Conduit couldn't save the unlock. Try again."));
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn On" }));
    await nextTask();
    expect(document.querySelector("[data-cv-error]")).toHaveTextContent("Try again.");
    expect(screen.queryByPlaceholderText("Enter master password")).toBeNull();
  });

  it("says when another vault stops unlocking automatically, and toasts it after Turn On", async () => {
    const home = "/v/Home.conduit";
    useStartupVaultStore.setState({ status: status({ startupVault: { kind: "personal", path: home, lineageId: "H" }, savedPath: home }) });
    invoke.mockResolvedValueOnce(status({ startupVault: { kind: "personal", path: VAULT, lineageId: "W" }, savedPath: VAULT, currentOn: true }));
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    expect(screen.getByText("Conduit will open Work instead of Home.conduit.")).toBeInTheDocument();
    expect(screen.getByText("Home will stop unlocking automatically.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn On" }));
    await nextTask();
    expect(toasts).toEqual([
      { type: "info", title: "Automatic unlock is off" },
      { type: "success", title: "Automatic unlock is on" },
    ]);
  });

  it("Use Touch ID Instead toasts that the other vault's automatic unlock is off", async () => {
    const home = "/v/Home.conduit";
    useVaultStore.setState({ biometricAvailable: true, biometricEnabled: true });
    useStartupVaultStore.setState({ status: status({ startupVault: { kind: "personal", path: home, lineageId: "H" }, savedPath: home }) });
    invoke.mockResolvedValueOnce({ status: status({ startupVault: { kind: "personal", path: VAULT, lineageId: "W" } }), forgot: true });
    render(<AutoUnlockWarningDialog mode="after-unlock" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Touch ID Instead" }));
    await nextTask();
    expect(toasts.map((t) => t.title)).toEqual(["Automatic unlock is off", "Work opens at startup"]);
  });

  it("names no other vault when this vault is the one saved", () => {
    useStartupVaultStore.setState({ status: status({ startupVault: { kind: "personal", path: VAULT, lineageId: "W" }, savedPath: VAULT }) });
    render(<AutoUnlockWarningDialog mode="settings" onClose={vi.fn()} />);
    expect(screen.queryByText(/will stop unlocking automatically/)).toBeNull();
  });
});
