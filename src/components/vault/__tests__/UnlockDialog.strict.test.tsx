import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import UnlockDialog from "../UnlockDialog";
import BiometricSetupPrompt from "../BiometricSetupPrompt";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

beforeEach(() => {
  invoke.mockResolvedValue(false);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ vaultExists: true, currentVaultPath: "/cloud/Vault.conduit", error: null, isLoading: false });
  useSyncStore.setState({ openError: null, takeoverMode: false });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("UnlockDialog take-over request under StrictMode", () => {
  it("keeps the take-over request it was opened with (StrictMode re-runs effects on mount)", async () => {
    useSyncStore.setState({ takeoverMode: true });
    render(
      <StrictMode>
        <UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );
    await nextTask();
    expect(useSyncStore.getState().takeoverMode).toBe(true);
    expect(screen.getByText("Unlock to use this vault here. It locks on the other device.")).toBeInTheDocument();
  });

  it("forgets the take-over request and the sync error once the dialog closes", async () => {
    useSyncStore.setState({ takeoverMode: true });
    const { unmount } = render(
      <StrictMode>
        <UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />
      </StrictMode>,
    );
    await nextTask();
    useSyncStore.setState({ openError: { code: "VAULT_FILE_UNREADABLE", fileName: "Vault.conduit" } as never });
    unmount();
    await nextTask();
    expect(useSyncStore.getState().takeoverMode).toBe(false);
    expect(useSyncStore.getState().openError).toBeNull();
  });
});

const panel = () => document.querySelector("[data-dialog-content]") as HTMLElement;
const pressEscape = () => fireEvent.keyDown(panel(), { key: "Escape" });
function clickScrim() {
  const scrim = panel().parentElement as HTMLElement;
  fireEvent.mouseDown(scrim);
  fireEvent.click(scrim);
}

describe("UnlockDialog on the Dialog primitive (spec 3.12.1, B8, B30, B31, B35)", () => {
  it("cancels on Escape, has no close button and ignores a scrim click", async () => {
    const onCancel = vi.fn();
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={onCancel} />);
    await nextTask();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    clickScrim();
    expect(onCancel).not.toHaveBeenCalled();
    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the unlock title, placeholder, field label and Cancel then Unlock in the form", async () => {
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(screen.getByRole("heading", { level: 2, name: "Unlock Vault" })).toBeInTheDocument();
    expect(screen.getByTitle("/cloud/Vault.conduit")).toHaveTextContent("Vault.conduit");
    const input = screen.getByPlaceholderText("Enter master password");
    expect(input.closest("label")?.querySelector("span")).toHaveTextContent("Master Password");
    const buttons = [...panel().querySelectorAll("[data-cv-dialog-footer] button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Cancel", "Unlock"]);
    expect(panel().querySelector("form button[type=submit]")).toHaveTextContent("Unlock");
  });

  it("shows Please wait... on the submit button while the unlock runs", async () => {
    useVaultStore.setState({ isLoading: true });
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    const submit = panel().querySelector("form button[type=submit]") as HTMLButtonElement;
    expect(submit).toHaveTextContent("Please wait...");
    expect(submit).toBeDisabled();
  });

  it("puts the unlock error in a data-cv-error line inside the dialog", async () => {
    useVaultStore.setState({ error: "Invalid master password" });
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(panel().querySelector("[data-cv-error]")).toHaveTextContent("Invalid master password");
  });

  it("creates a vault with both placeholders and flags a mismatch with data-cv-error", async () => {
    useVaultStore.setState({ vaultExists: false });
    render(<UnlockDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await nextTask();
    expect(screen.getByRole("heading", { level: 2, name: "Create Vault" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Enter master password"), { target: { value: "one-password" } });
    fireEvent.change(screen.getByPlaceholderText("Confirm master password"), { target: { value: "other" } });
    expect(panel().querySelector("[data-cv-error]")).toHaveTextContent("Passwords do not match");
    expect(panel().querySelector("form button[type=submit]")).toHaveTextContent("Create Vault");
  });
});

describe("BiometricSetupPrompt close behavior (spec 3.12.1)", () => {
  it("dismisses like Not Now on Escape, with no close button and no scrim close", () => {
    const onDismiss = vi.fn();
    render(<BiometricSetupPrompt onDismiss={onDismiss} onAccept={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2, name: "Enable Quick Unlock" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    clickScrim();
    expect(onDismiss).not.toHaveBeenCalled();
    pressEscape();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Not Now" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
