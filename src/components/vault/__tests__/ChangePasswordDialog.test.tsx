import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import ChangePasswordDialog from "../ChangePasswordDialog";
import { useSyncStore } from "../../../stores/syncStore";
import type { SyncStateResponse } from "../../../types/sync";

vi.mock("../../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const ERASE_LABEL = /Also permanently delete items in Recently deleted/;

function syncState(engine: boolean): SyncStateResponse {
  return {
    enabled: true,
    killSwitch: false,
    vault: { lineageId: "L", path: "/cloud/Vault.conduit", fileName: "Vault.conduit", shared: true, engine },
    status: null,
    deviceLimit: null,
    sideFiles: [],
    notices: [],
    pendingVaults: [],
    softLocked: false,
    ownership: null,
    deviceCap: null,
  } as unknown as SyncStateResponse;
}

function fill(current: string, next: string) {
  fireEvent.change(screen.getByPlaceholderText("Enter current password"), { target: { value: current } });
  fireEvent.change(screen.getByPlaceholderText("Enter new password"), { target: { value: next } });
  fireEvent.change(screen.getByPlaceholderText("Confirm new password"), { target: { value: next } });
}

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
  });
}

beforeEach(() => {
  invoke.mockResolvedValue(undefined);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  useSyncStore.setState({ state: null });
});

describe("ChangePasswordDialog: erase Recently deleted (spec 4.7)", () => {
  it("offers the option on a synced vault and sends it when ticked", async () => {
    useSyncStore.setState({ state: syncState(true) });
    const onClose = vi.fn();
    render(<ChangePasswordDialog onClose={onClose} />);
    fill("old-password-1", "new-password-1");
    const box = screen.getByLabelText(ERASE_LABEL) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await submit();
    expect(invoke).toHaveBeenCalledWith("vault_change_password", {
      currentPassword: "old-password-1",
      newPassword: "new-password-1",
      eraseRecentlyDeleted: true,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("leaves Recently deleted alone unless the option is ticked", async () => {
    useSyncStore.setState({ state: syncState(true) });
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill("old-password-1", "new-password-1");
    await submit();
    expect(invoke).toHaveBeenCalledWith("vault_change_password", expect.objectContaining({ eraseRecentlyDeleted: false }));
  });

  it("hides the option when the vault is not synced", async () => {
    useSyncStore.setState({ state: syncState(false) });
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    expect(screen.queryByLabelText(ERASE_LABEL)).toBeNull();
    fill("old-password-1", "new-password-1");
    await submit();
    expect(invoke).toHaveBeenCalledWith("vault_change_password", expect.objectContaining({ eraseRecentlyDeleted: false }));
  });
});

describe("ChangePasswordDialog: errors (B8, B31)", () => {
  const panel = () => document.querySelector("[data-dialog-content]") as HTMLElement;

  it("shows the reason the main process gives in a data-cv-error line inside the form dialog", async () => {
    invoke.mockRejectedValue(new Error("Current password is incorrect"));
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill("old-password-1", "new-password-1");
    await submit();
    expect(panel().querySelector("form [data-cv-error]")).toHaveTextContent("Current password is incorrect");
  });

  it("falls back to a generic message when the error has no text", async () => {
    invoke.mockRejectedValue(new Error(""));
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill("old-password-1", "new-password-1");
    await submit();
    expect(panel().querySelector("form [data-cv-error]")).toHaveTextContent("Failed to change password");
  });
});
