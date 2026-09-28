import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import ChangePasswordDialog from "../ChangePasswordDialog";
import RenameVaultDialog from "../RenameVaultDialog";
import CloudRestoreDialog from "../CloudRestoreDialog";
import RecoveryPassphraseDialog from "../RecoveryPassphraseDialog";
import ProVaultLockDialog from "../ProVaultLockDialog";
import BackupManagerDialog from "../BackupManagerDialog";
import ExportDialog from "../ExportDialog";
import VaultImportDialog from "../VaultImportDialog";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore, type CloudBackupEntry } from "../../../stores/vaultStore";
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

// Close behavior of every vault lifecycle dialog on the Dialog primitive (spec 3.12.1). They live here
// because R3-VAULT owns only this dialog test file besides the unlock and hub tests.
const panel = () => document.querySelector("[data-dialog-content]") as HTMLElement;
const pressEscape = () => fireEvent.keyDown(panel(), { key: "Escape" });
function clickScrim() {
  const scrim = panel().parentElement as HTMLElement;
  fireEvent.mouseDown(scrim);
  fireEvent.click(scrim);
}
/** The header close button (an IconButton labelled Close), not a footer button that reads Close. */
const closeButton = () => panel().querySelector<HTMLButtonElement>('button[aria-label="Close"]');

/** Escape, a scrim click and a close button all do nothing, and no close button is drawn. */
function expectUndismissable(spies: ReadonlyArray<ReturnType<typeof vi.fn>>) {
  expect(closeButton()).toBeNull();
  pressEscape();
  clickScrim();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(panel()).toBeInTheDocument();
}

const BACKUPS: CloudBackupEntry[] = [
  { name: "b1", path: "backups/acme/1", created_at: new Date().toISOString(), size: 2048, vaultId: "v1", vaultName: "Acme" },
  { name: "b2", path: "backups/acme/2", created_at: new Date(Date.now() - 60_000).toISOString(), size: 1024, vaultId: "v1", vaultName: "Acme" },
];

describe("vault lifecycle dialogs keep today's close behavior (spec 3.12.1)", () => {
  it("Change Password: no Escape, no scrim close, no close button", () => {
    const onClose = vi.fn();
    render(<ChangePasswordDialog onClose={onClose} />);
    expect(screen.getByRole("heading", { level: 2, name: "Change Password" })).toBeInTheDocument();
    expectUndismissable([onClose]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Change Password: the error is a data-cv-error line inside the form dialog (B8, B31)", async () => {
    invoke.mockRejectedValue(new Error("Current password is incorrect"));
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    fill("old-password-1", "new-password-1");
    await submit();
    expect(panel().querySelector("form [data-cv-error]")).toHaveTextContent("Failed to change password");
  });

  it("Rename Vault: no Escape, no scrim close, no close button; keeps its placeholder", () => {
    useVaultStore.setState({ currentVaultPath: "/v/Acme.conduit", vaultType: "personal", teamVaultId: null });
    const onClose = vi.fn();
    render(<RenameVaultDialog onClose={onClose} />);
    expect(screen.getByPlaceholderText("Enter new vault name")).toHaveValue("Acme");
    expect(screen.getByText("Change the display name of this vault")).toBeInTheDocument();
    expectUndismissable([onClose]);
    expect(panel().querySelector("form button[type=submit]")).toHaveTextContent("Rename");
  });

  it("Welcome Back: no Escape, no scrim close, no close button", () => {
    const onRestore = vi.fn();
    const onCreateNew = vi.fn();
    render(<CloudRestoreDialog onRestore={onRestore} onCreateNew={onCreateNew} />);
    expect(screen.getByRole("heading", { level: 2, name: "Welcome Back" })).toBeInTheDocument();
    expectUndismissable([onRestore, onCreateNew]);
  });

  it("Save Your Recovery Passphrase: cannot be dismissed before it is saved", () => {
    const onConfirm = vi.fn();
    render(<RecoveryPassphraseDialog passphrase="alpha bravo charlie delta echo foxtrot" onConfirm={onConfirm} />);
    expectUndismissable([onConfirm]);
    const saved = screen.getByRole("button", { name: "I've Saved It" });
    expect(saved).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I have saved my recovery passphrase in a secure location"));
    fireEvent.click(saved);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Team Vault In Use: no Escape, no scrim close, no close button", () => {
    const onCancel = vi.fn();
    render(<ProVaultLockDialog lockedByEmail="a@b.c" lockedAt={new Date().toISOString()} onRetry={vi.fn()} onUpgrade={vi.fn()} onCancel={onCancel} />);
    expect(screen.getByRole("heading", { level: 2, name: "Team Vault In Use" })).toBeInTheDocument();
    expectUndismissable([onCancel]);
    expect(["Cancel", "Try Again", "Upgrade to Teams"].map((name) => screen.getByRole("button", { name }).textContent)).toEqual([
      "Cancel",
      "Try Again",
      "Upgrade to Teams",
    ]);
  });

  describe("Backup Manager (B25, B42)", () => {
    beforeEach(() => {
      useVaultStore.setState({
        cloudBackups: BACKUPS,
        loadingBackups: false,
        currentVaultPath: "/v/Acme.conduit",
        listCloudBackups: vi.fn(async () => {}),
        getCloudBackupRetention: vi.fn(async () => {}),
      });
    });

    it("closes on Escape and on its close button, not on a scrim click, on the sync layer", () => {
      const onClose = vi.fn();
      render(<BackupManagerDialog onClose={onClose} />);
      expect(panel()).toHaveAttribute("data-cv-backup-manager");
      expect(panel().parentElement).toHaveAttribute("data-cv-layer", "sync");
      clickScrim();
      expect(onClose).not.toHaveBeenCalled();
      pressEscape();
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(closeButton() as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("keeps Restore, the Master password field, Confirm and Close", () => {
      const onClose = vi.fn();
      render(<BackupManagerDialog onClose={onClose} />);
      const root = panel();
      const restore = [...root.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Restore");
      expect(restore).toHaveLength(2);
      fireEvent.click(restore[0]);
      expect(root.querySelector('input[placeholder="Master password"]')).not.toBeNull();
      expect([...root.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Confirm")).toBe(true);
      const close = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close") as HTMLButtonElement;
      fireEvent.click(close);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Export and Import Vault close unless busy", () => {
    it("Export: Escape, a scrim click and the close button close it while configuring", () => {
      const onClose = vi.fn();
      render(<ExportDialog onClose={onClose} />);
      pressEscape();
      clickScrim();
      fireEvent.click(closeButton() as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(3);
    });

    it("Export: nothing closes it while it exports", async () => {
      invoke.mockImplementation(async (channel) => {
        if (channel === "export_pick_file") return "/tmp/out.conduit-export";
        if (channel === "export_execute") return new Promise(() => {});
        return undefined;
      });
      const onClose = vi.fn();
      render(<ExportDialog onClose={onClose} />);
      fireEvent.change(screen.getByPlaceholderText("Enter a passphrase to encrypt the export"), { target: { value: "long-passphrase" } });
      fireEvent.change(screen.getByPlaceholderText("Re-enter passphrase"), { target: { value: "long-passphrase" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Export" }));
      });
      expect(screen.getByText("Exporting and encrypting vault data...")).toBeInTheDocument();
      expectUndismissable([onClose]);
    });

    it("Import: Escape, a scrim click and the close button close it on the file step", () => {
      const onClose = vi.fn();
      render(<VaultImportDialog onClose={onClose} />);
      pressEscape();
      clickScrim();
      fireEvent.click(closeButton() as HTMLElement);
      expect(onClose).toHaveBeenCalledTimes(3);
    });

    it("Import: nothing closes it while it imports", async () => {
      invoke.mockImplementation(async (channel) => {
        if (channel === "import_pick_export_file") return "/tmp/in.conduit-export";
        if (channel === "import_preview_export") {
          return {
            source_vault_name: "Acme",
            exported_at: new Date().toISOString(),
            scope: "full",
            scope_path: null,
            folder_count: 1,
            entry_count: 3,
            entry_type_counts: { ssh: 3 },
            folder_tree: [],
          };
        }
        if (channel === "import_execute_export") return new Promise(() => {});
        return undefined;
      });
      const onClose = vi.fn();
      render(<VaultImportDialog onClose={onClose} />);
      await act(async () => {
        fireEvent.click(screen.getByText("Choose .conduit-export file..."));
      });
      fireEvent.change(screen.getByPlaceholderText("Enter the passphrase used during export"), { target: { value: "secret" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Import 3 Entries" }));
      });
      expect(screen.getByText("Importing entries and folders...")).toBeInTheDocument();
      expectUndismissable([onClose]);
    });
  });
});
