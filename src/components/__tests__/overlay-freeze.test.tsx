import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { freezeHolders, isFrozen } from "../../lib/native-freeze";
import QuickConnect from "../connections/QuickConnect";
import SettingsDialog from "../settings/SettingsDialog";
import CredentialManager from "../vault/CredentialManager";
import EntryDialog from "../entries/EntryDialog";
import FolderDialog from "../entries/FolderDialog";
import UnlockDialog from "../vault/UnlockDialog";
import CloudRestoreDialog from "../vault/CloudRestoreDialog";
import AboutDialog from "../about/AboutDialog";
import PasswordGeneratorDialog from "../tools/PasswordGeneratorDialog";
import SshKeyGeneratorDialog from "../tools/SshKeyGeneratorDialog";
import ImportDialog from "../import/ImportDialog";
import DeviceSetupDialog from "../vault/DeviceSetupDialog";
import CreateTeamVaultDialog from "../vault/CreateTeamVaultDialog";
import TeamVaultUnlock from "../vault/TeamVaultUnlock";
import VaultSettingsDialog from "../vault/VaultSettingsDialog";
import ExportDialog from "../vault/ExportDialog";
import VaultImportDialog from "../vault/VaultImportDialog";
import RenameVaultDialog from "../vault/RenameVaultDialog";
import ChangePasswordDialog from "../vault/ChangePasswordDialog";
import FeedbackDialog from "../feedback/FeedbackDialog";
import WhatsNewDialog from "../whats-new/WhatsNewDialog";
import DeviceAuthApprovalDialog from "../vault/DeviceAuthApprovalDialog";

vi.mock("../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), update: vi.fn() } }));

// IPC answers the overlays read while they mount; any other channel resolves to null.
const IPC_RESULTS: Readonly<Record<string, unknown>> = {
  settings_get: {},
  credential_list: [],
  entry_list: [],
  folder_list: [],
  app_get_version: "0.18.0",
  vault_get_recent: [],
  team_get_members: [],
  team_check_invitations: [],
  team_vault_list: [],
  team_vault_folder_permissions: [],
  team_vault_list_members: [],
  team_vault_list_folder_permissions: [],
};

const noop = () => {};

/**
 * The 24 overlay flags App.tsx folds into its `legacy` freeze (spec 4.9, D-28), each with the overlay
 * it opens. Rendered alone, without App.tsx, every one must hold a freeze of its own.
 */
const OVERLAYS: ReadonlyArray<readonly [flag: string, element: () => ReactElement]> = [
  ["showQuickConnect", () => <QuickConnect onClose={noop} />],
  ["showSettings", () => <SettingsDialog initialTab="general" onClose={noop} />],
  ["showCredentials", () => <CredentialManager onClose={noop} />],
  ["showEntryDialog", () => <EntryDialog folderId={null} onClose={noop} />],
  ["showFolderDialog", () => <FolderDialog parentId={null} onClose={noop} />],
  ["showUnlockDialog", () => <UnlockDialog onSuccess={noop} onCancel={noop} />],
  ["showCloudRestore", () => <CloudRestoreDialog onRestore={noop} onCreateNew={noop} />],
  ["showAbout", () => <AboutDialog onClose={noop} />],
  ["showPasswordGenerator", () => <PasswordGeneratorDialog onClose={noop} />],
  ["showSshKeyGenerator", () => <SshKeyGeneratorDialog onClose={noop} />],
  ["showImportDialog", () => <ImportDialog onClose={noop} />],
  ["showDeviceSetup", () => <DeviceSetupDialog onComplete={noop} onSkip={noop} />],
  ["showCreateTeamVault", () => <CreateTeamVaultDialog onClose={noop} />],
  ["teamVaultToUnlock", () => <TeamVaultUnlock teamVaultId="tv-1" vaultName="Ops" onSuccess={noop} onCancel={noop} />],
  ["editingEntryId", () => <EntryDialog editingEntryId="e-1" onClose={noop} />],
  ["editingFolderId", () => <FolderDialog editingFolderId="f-1" onClose={noop} />],
  ["pendingDeviceAuth", () => <DeviceAuthApprovalDialog requestId="r-1" deviceName="iPhone" onClose={noop} />],
  ["showVaultSettings", () => <VaultSettingsDialog initialTab="members" onClose={noop} />],
  ["showExportDialog", () => <ExportDialog onClose={noop} />],
  ["showVaultImportDialog", () => <VaultImportDialog onClose={noop} />],
  ["showRenameVaultDialog", () => <RenameVaultDialog onClose={noop} />],
  ["showChangePasswordDialog", () => <ChangePasswordDialog onClose={noop} />],
  ["feedbackType", () => <FeedbackDialog type="bug" onClose={noop} />],
  ["showWhatsNew", () => <WhatsNewDialog onClose={noop} />],
];

beforeEach(() => {
  const invoke = vi.fn(async (channel: string) => IPC_RESULTS[channel] ?? null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every App.tsx overlay holds its own freeze (spec 4.9)", () => {
  it("lists the 24 overlay flags of App.tsx", () => {
    expect(OVERLAYS).toHaveLength(24);
    expect(new Set(OVERLAYS.map(([flag]) => flag)).size).toBe(24);
  });

  it.each(OVERLAYS)("%s: its overlay freezes the native views while open, and only while open", async (_flag, element) => {
    const view = render(element());
    await act(async () => {});
    expect(isFrozen()).toBe(true);
    expect(freezeHolders().some((h) => h.reason !== "legacy")).toBe(true);
    view.unmount();
    expect(freezeHolders()).toEqual([]);
  });
});
