import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import UnlockDialog from "../UnlockDialog";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useStartupVaultStore, type StartupStatus } from "../../../stores/startupVaultStore";

const VAULT = "/cloud/Work.conduit";
const calls: { channel: string; args?: unknown }[] = [];
let status: StartupStatus;
let replies: Record<string, (args?: unknown) => unknown>;

const invoke = vi.fn(async (channel: string, args?: unknown) => {
  calls.push({ channel, args });
  const reply = replies[channel];
  return reply ? reply(args) : false;
});

const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));
const panel = () => document.querySelector("[data-dialog-content]") as HTMLElement;
const channels = () => calls.map((c) => c.channel);

function makeStatus(over: Partial<StartupStatus> = {}): StartupStatus {
  return { platform: "darwin", store: { usable: true, reason: "ok", storeName: "system keychain" }, startupVault: null, savedPath: null, currentOn: false, ...over };
}

beforeEach(() => {
  calls.length = 0;
  status = makeStatus();
  replies = {
    auto_unlock_status: () => status,
    vault_unlock: () => undefined,
    credential_list: () => [],
    biometric_available: () => false,
  };
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ vaultExists: true, currentVaultPath: VAULT, vaultType: "personal", error: null, isLoading: false, biometricAvailable: false, biometricEnabled: false, biometricUnlockInProgress: false });
  useSyncStore.setState({ openError: null, takeoverMode: false });
  useStartupVaultStore.setState({ status: null, fallback: null, confirm: null });
});

// The dialog clears the sync request one task after it unmounts (useForgetUnlockRequestOnClose).
const settle = () => new Promise<void>((r) => setTimeout(r, 1));

afterEach(async () => {
  cleanup();
  await settle();
  invoke.mockClear();
});

const checkbox = () => screen.queryByRole("checkbox", { name: /Unlock automatically at startup/ });

async function submitPassword(pw = "pw-123456") {
  fireEvent.change(screen.getByPlaceholderText("Enter master password"), { target: { value: pw } });
  fireEvent.submit(panel().querySelector("form") as HTMLFormElement);
  await nextTask();
  await nextTask();
}

describe("the automatic unlock checkbox (docs/AUTO_UNLOCK.md 2.1)", () => {
  it("shows unchecked for a personal vault when the store is usable and nothing is saved", async () => {
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(checkbox()).not.toBeNull();
    expect(checkbox()).not.toBeChecked();
    expect(screen.getByText("Opens this vault when Conduit starts, without the password.")).toBeInTheDocument();
  });

  it("hides when the store is weak, in take-over mode, for a team vault, or when this vault is already saved", async () => {
    for (const setup of [
      () => (status = makeStatus({ store: { usable: false, reason: "weak", storeName: "system keyring" } })),
      () => useSyncStore.setState({ takeoverMode: true }),
      () => useVaultStore.setState({ vaultType: "team" }),
      () => (status = makeStatus({ savedPath: VAULT })),
    ]) {
      setup();
      render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
      await nextTask();
      expect(checkbox()).toBeNull();
      cleanup();
      await settle();
      status = makeStatus();
      useSyncStore.setState({ takeoverMode: false });
      useVaultStore.setState({ vaultType: "personal" });
    }
  });

  it("checked plus a successful unlock swaps to the warning; Cancel keeps the vault open and seals nothing", async () => {
    const onSuccess = vi.fn();
    render(<UnlockDialog onSuccess={onSuccess} onCancel={vi.fn()} />);
    await nextTask();
    fireEvent.click(checkbox() as HTMLElement);
    await submitPassword();
    expect(screen.getByRole("heading", { name: "Unlock Work automatically?" })).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(channels()).not.toContain("auto_unlock_enable");
  });

  it("Turn On in the warning seals with the recent-unlock proof", async () => {
    replies.auto_unlock_enable = () => makeStatus({ savedPath: VAULT, currentOn: true });
    const onSuccess = vi.fn();
    render(<UnlockDialog onSuccess={onSuccess} onCancel={vi.fn()} />);
    await nextTask();
    fireEvent.click(checkbox() as HTMLElement);
    await submitPassword();
    fireEvent.click(screen.getByRole("button", { name: "Turn On" }));
    await nextTask();
    expect(calls.find((c) => c.channel === "auto_unlock_enable")?.args).toEqual({ proof: { kind: "recent-unlock" } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("appears only after the Touch ID prompt that starts by itself is cancelled", async () => {
    let rejectTouchId: (err: Error) => void = () => undefined;
    replies.biometric_available = () => true;
    replies.biometric_enabled = () => true;
    replies.biometric_unlock = () => new Promise((_, reject) => (rejectTouchId = reject));
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(checkbox()).toBeNull();
    await act(async () => rejectTouchId(new Error("Authentication was cancelled")));
    await nextTask();
    expect(checkbox()).not.toBeNull();
  });

  it("after a lock of a vault with a saved unlock, says why the password is asked", async () => {
    status = makeStatus({ savedPath: VAULT });
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(screen.getByText("Automatic unlock runs when Conduit starts. Enter your master password.")).toBeInTheDocument();
  });

  it("StrictMode mounts never start an automatic unlock", async () => {
    render(
      <StrictMode>
        <UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );
    await nextTask();
    expect(channels()).not.toContain("vault_auto_unlock");
  });
});

describe("fallbacks of an automatic attempt (spec 2.1, 4.4)", () => {
  it("stale: the warning note, a checked keep box, and success re-seals", async () => {
    useStartupVaultStore.setState({ fallback: { kind: "stale", name: "Work" } });
    replies.vault_auto_unlock = () => ({ ok: true });
    replies.auto_unlock_enable = () => makeStatus({ savedPath: VAULT, currentOn: true });
    const onSuccess = vi.fn();
    render(<UnlockDialog onSuccess={onSuccess} onCancel={vi.fn()} />);
    await nextTask();
    expect(screen.getByText(/Conduit couldn't open Work automatically/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Keep unlocking automatically at startup/ })).toBeChecked();
    await submitPassword("new-pw");
    expect(calls.find((c) => c.channel === "vault_auto_unlock")?.args).toEqual({ password: "new-pw" });
    expect(calls.find((c) => c.channel === "auto_unlock_enable")?.args).toEqual({ proof: { kind: "recent-unlock" } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("unreadable: names the store and offers Turn Off Automatic Unlock", async () => {
    useStartupVaultStore.setState({ fallback: { kind: "unreadable", name: "Work" } });
    replies.auto_unlock_disable = () => makeStatus();
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(screen.getByText(/couldn't read the saved unlock from the system keychain/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn Off Automatic Unlock" }));
    await nextTask();
    expect(channels()).toContain("auto_unlock_disable");
  });

  it("never starts Touch ID by itself in a fallback", async () => {
    useStartupVaultStore.setState({ fallback: { kind: "saved", name: "Work" } });
    replies.biometric_available = () => true;
    replies.biometric_enabled = () => true;
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(channels()).not.toContain("biometric_unlock");
  });

  it("Cancel on a gate dialog of the automatic attempt closes the whole dialog", async () => {
    useStartupVaultStore.setState({ fallback: { kind: "saved", name: "Work" } });
    useSyncStore.setState({ openError: { code: "VAULT_SIGN_IN_REQUIRED", fileName: "Work.conduit" } as never });
    const onCancel = vi.fn();
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={onCancel} />);
    await nextTask();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await nextTask();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(channels()).toContain("vault_startup_done");
    expect(useStartupVaultStore.getState().fallback).toBeNull();
  });

  it("a typed attempt keeps today's behavior: Cancel on a gate dialog returns to the password form", async () => {
    useSyncStore.setState({ openError: { code: "VAULT_SIGN_IN_REQUIRED", fileName: "Work.conduit" } as never });
    const onCancel = vi.fn();
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={onCancel} />);
    await nextTask();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await nextTask();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Enter master password")).toBeInTheDocument();
  });

  it("the take-over retry of the automatic attempt repeats it with takeover", async () => {
    useStartupVaultStore.setState({ fallback: { kind: "saved", name: "Work" } });
    useSyncStore.setState({
      openError: { code: "VAULT_OPEN_ELSEWHERE", holders: [], limit: 1, fileName: "Work.conduit", locationDiffers: false, via: "server", cause: "vault_limit", deviceCap: null, displaceDeviceName: null, alsoLockDeviceName: null } as never,
    });
    replies.vault_auto_unlock = () => ({ ok: true });
    const onSuccess = vi.fn();
    render(<UnlockDialog onSuccess={onSuccess} onCancel={vi.fn()} />);
    await nextTask();
    fireEvent.click(screen.getByRole("button", { name: /Use here instead/i }));
    await nextTask();
    await nextTask();
    expect(calls.find((c) => c.channel === "vault_auto_unlock")?.args).toEqual({ takeover: true });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
