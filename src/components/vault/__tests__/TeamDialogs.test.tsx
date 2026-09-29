import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import type { ReactElement } from "react";
import VaultSettingsDialog from "../VaultSettingsDialog";
import CreateTeamVaultDialog from "../CreateTeamVaultDialog";
import TeamVaultUnlock from "../TeamVaultUnlock";
import DeviceSetupDialog from "../DeviceSetupDialog";
import DeviceAuthApprovalDialog from "../DeviceAuthApprovalDialog";
import AuditLogViewer from "../AuditLogViewer";
import CredentialManager from "../CredentialManager";
import CredentialForm from "../CredentialForm";
import CredentialPicker from "../CredentialPicker";
import PasswordHistoryDialog from "../PasswordHistoryDialog";
import { useTeamStore } from "../../../stores/teamStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useAuthStore } from "../../../stores/authStore";
import type { CredentialMeta } from "../../../types/credential";

vi.mock("../../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

type Reply = { value?: unknown; reject?: string; hang?: boolean };
let replies: Record<string, Reply> = {};
const invoke = vi.fn(async (channel: string) => {
  const reply = replies[channel];
  if (reply?.hang) return new Promise(() => {});
  if (reply?.reject) throw new Error(reply.reject);
  return reply?.value;
});

const CREDENTIALS: CredentialMeta[] = [
  { id: "c1", name: "Domain Admin", username: "administrator", domain: "ACME", tags: ["prod"], credential_type: null, created_at: "2026-01-01" },
  { id: "c2", name: "Deploy Key", username: "deploy", domain: null, tags: [], credential_type: "ssh_key", created_at: "2026-01-02" },
];

const MEMBERS = [
  { user_id: "u1", role: "admin", user_email: "owner@acme.test", user_display_name: "Olivia Owner", created_at: "2026-01-01" },
  { user_id: "u2", role: "editor", user_email: "ed@acme.test", user_display_name: "Ed Editor", created_at: "2026-01-01" },
];

const TEAM = { id: "t1", name: "Acme", slug: "acme", owner_id: "u1", max_seats: 5, created_at: "", updated_at: "" };

async function show(ui: ReactElement) {
  const result = render(ui);
  await act(async () => {});
  return result;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function title(): string {
  return within(dialog()).getByRole("heading", { level: 2 }).textContent ?? "";
}

function footer(): string[] {
  const bar = dialog().querySelector("[data-cv-dialog-footer]");
  return Array.from(bar?.querySelectorAll("button") ?? []).map((b) => b.textContent?.trim() ?? "");
}

function headerClose(): HTMLElement | null {
  return dialog().querySelector('button[aria-label="Close"]');
}

function pressEscape() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

function clickScrim() {
  const scrim = dialog().parentElement as HTMLElement;
  fireEvent.mouseDown(scrim);
  fireEvent.click(scrim);
}

/** Spec 3.12.1: Escape, a scrim click and the close button's presence, per dialog. */
function expectCloseBehavior(onClose: ReturnType<typeof vi.fn>, { escape, scrim, button }: { escape: boolean; scrim: boolean; button: boolean }) {
  expect(headerClose() !== null).toBe(button);
  clickScrim();
  expect(onClose).toHaveBeenCalledTimes(scrim ? 1 : 0);
  onClose.mockClear();
  pressEscape();
  expect(onClose).toHaveBeenCalledTimes(escape ? 1 : 0);
}

beforeEach(() => {
  replies = {};
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockClear();
  useTeamStore.getState().reset();
  useVaultStore.setState({ isUnlocked: false, credentials: [], vaultType: "personal", teamVaultId: null });
  useAuthStore.setState({ user: null, profile: null });
});

describe("CreateTeamVaultDialog", () => {
  it("asks for an identity key first: Cancel then Generate Identity Key; no close button, no Escape, no scrim", async () => {
    replies = { identity_key_exists: { value: false } };
    const onClose = vi.fn();
    await show(<CreateTeamVaultDialog onClose={onClose} />);
    expect(title()).toBe("Create Team Vault");
    expect(screen.getByText("Shared, zero-knowledge encrypted")).toBeInTheDocument();
    expect(screen.getByText("Identity Key Required")).toBeInTheDocument();
    expect(footer()).toEqual(["Cancel", "Generate Identity Key"]);
    expectCloseBehavior(onClose, { escape: false, scrim: false, button: false });
  });

  it("shows the Name and Description fields with Cancel then Create Vault, disabled until a name is typed", async () => {
    replies = { identity_key_exists: { value: true } };
    await show(<CreateTeamVaultDialog onClose={vi.fn()} />);
    const name = screen.getByLabelText("Name");
    expect(name).toHaveAttribute("placeholder", "e.g. Production Credentials");
    expect(screen.getByPlaceholderText("Brief description of what this vault contains")).toBeInTheDocument();
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(footer()).toEqual(["Cancel", "Create Vault"]);
    expect(screen.getByRole("button", { name: "Create Vault" })).toBeDisabled();
    fireEvent.change(name, { target: { value: "Prod" } });
    expect(screen.getByRole("button", { name: "Create Vault" })).toBeEnabled();
  });
});

describe("TeamVaultUnlock", () => {
  it("shows the connecting state with Cancel only; no close button, no Escape, no scrim", async () => {
    replies = { team_vault_open: { hang: true } };
    const onCancel = vi.fn();
    await show(<TeamVaultUnlock teamVaultId="tv1" vaultName="Acme Team Vault" onSuccess={vi.fn()} onCancel={onCancel} />);
    expect(title()).toBe("Team Vault");
    expect(screen.getByText("Acme Team Vault")).toBeInTheDocument();
    expect(screen.getByText("Connecting to team vault...")).toBeInTheDocument();
    expect(screen.getByText("Decrypting vault key with your identity")).toBeInTheDocument();
    expect(footer()).toEqual(["Cancel"]);
    expectCloseBehavior(onCancel, { escape: false, scrim: false, button: false });
  });

  it("shows the error with Cancel then Try Again", async () => {
    replies = { team_vault_open: { reject: "Network unreachable" } };
    await show(<TeamVaultUnlock teamVaultId="tv1" vaultName="Acme Team Vault" onSuccess={vi.fn()} onCancel={vi.fn()} />);
    expect(dialog().querySelector("[data-cv-error]")?.textContent).toBe("Network unreachable");
    expect(footer()).toEqual(["Cancel", "Try Again"]);
  });
});

describe("DeviceSetupDialog", () => {
  it("first time: Skip for now then Generate Identity Key; no close button, no Escape, no scrim", async () => {
    replies = { identity_key_has_backup: { value: false } };
    const onSkip = vi.fn();
    await show(<DeviceSetupDialog onComplete={vi.fn()} onSkip={onSkip} />);
    expect(title()).toBe("Set Up Team Access");
    expect(screen.getByText("Configure this device for team vaults")).toBeInTheDocument();
    expect(footer()).toEqual(["Skip for now", "Generate Identity Key"]);
    expectCloseBehavior(onSkip, { escape: false, scrim: false, button: false });
  });

  it("with a backup: the two recovery options in order, then the passphrase field with Back then Recover", async () => {
    replies = { identity_key_has_backup: { value: true } };
    await show(<DeviceSetupDialog onComplete={vi.fn()} onSkip={vi.fn()} />);
    const options = within(dialog())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(options.indexOf("Enter Recovery PassphraseUse your 6-word recovery passphrase")).toBeLessThan(
      options.indexOf("Authorize From Existing DeviceApprove access from a device you already use"),
    );
    expect(footer()).toEqual(["Skip for now"]);
    fireEvent.click(screen.getByRole("button", { name: /Enter Recovery Passphrase/ }));
    expect(screen.getByPlaceholderText("word1 word2 word3 word4 word5 word6")).toBeInTheDocument();
    expect(footer()).toEqual(["Back", "Recover"]);
    expect(screen.getByRole("button", { name: "Recover" })).toBeDisabled();
  });
});

describe("DeviceAuthApprovalDialog", () => {
  it("names the device, offers Deny then Approve; no close button, no Escape, no scrim", async () => {
    const onClose = vi.fn();
    await show(<DeviceAuthApprovalDialog requestId="r1" deviceName="Chris MacBook Pro" onClose={onClose} />);
    expect(title()).toBe("Device Authorization Request");
    expect(screen.getByText("Device:")).toBeInTheDocument();
    expect(screen.getByText("Chris MacBook Pro")).toBeInTheDocument();
    expect(footer()).toEqual(["Deny", "Approve"]);
    expectCloseBehavior(onClose, { escape: false, scrim: false, button: false });
  });

  it("approves the request", async () => {
    await show(<DeviceAuthApprovalDialog requestId="r1" deviceName="Laptop" onClose={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });
    expect(invoke).toHaveBeenCalledWith("device_auth_approve", { requestId: "r1" });
    expect(screen.getByText("Device authorized successfully")).toBeInTheDocument();
  });
});

describe("VaultSettingsDialog", () => {
  beforeEach(() => {
    replies = { team_vault_list_members: { value: MEMBERS }, team_get_members: { value: [] }, team_audit_log: { value: [] } };
    useVaultStore.setState({ vaultType: "team", teamVaultId: "tv1" });
    useTeamStore.setState({ team: TEAM, myRole: "admin", teamVaults: [{ id: "tv1", team_id: "t1", name: "Acme Team Vault", description: null, created_by: "u1", member_count: 2, created_at: "", updated_at: "" }] });
    useAuthStore.setState({ user: { id: "u1", email: "owner@acme.test" } as never });
  });

  it("keeps its title, vault name, nav order and Done; close button only, no Escape, no scrim", async () => {
    const onClose = vi.fn();
    await show(<VaultSettingsDialog onClose={onClose} />);
    expect(title()).toBe("Vault Settings");
    expect(screen.getByText("Acme Team Vault").closest("[data-cv-dialog-subtitle]")).not.toBeNull();
    const nav = within(dialog()).getByRole("navigation");
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Members", "Permissions", "Activity"]);
    expect(within(nav).getByRole("button", { name: "Members" })).toHaveAttribute("data-selected");
    expect(screen.getByText("Olivia Owner")).toBeInTheDocument();
    expect(screen.getByText("Ed Editor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove member" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Team Member" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rotate Key" })).toBeInTheDocument();
    expect(footer()).toEqual(["Done"]);
    expectCloseBehavior(onClose, { escape: false, scrim: false, button: true });
  });

  it("hides Activity from non-admins and switches tabs from the nav", async () => {
    useTeamStore.setState({ myRole: "member" });
    await show(<VaultSettingsDialog onClose={vi.fn()} />);
    const nav = within(dialog()).getByRole("navigation");
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Members", "Permissions"]);
    fireEvent.click(within(nav).getByRole("button", { name: "Permissions" }));
    expect(within(nav).getByRole("button", { name: "Permissions" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("No folders in this vault yet.")).toBeInTheDocument();
  });
});

describe("AuditLogViewer (standalone)", () => {
  it("keeps its title, team name, filters and Close; close button only, no Escape, no scrim", async () => {
    replies = { team_audit_log: { value: [] } };
    useTeamStore.setState({ team: TEAM });
    const onClose = vi.fn();
    await show(<AuditLogViewer teamVaultId="tv1" onClose={onClose} />);
    expect(title()).toBe("Audit Log");
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All Events" })).toBeInTheDocument();
    expect(screen.getByText("Entries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Created entry" })).toBeInTheDocument();
    expect(screen.getByText("No activity found.")).toBeInTheDocument();
    expect(screen.getByText("Audit logs are retained for 2 years.")).toBeInTheDocument();
    expect(footer()).toEqual(["Close"]);
    expectCloseBehavior(onClose, { escape: false, scrim: false, button: true });
  });
});

describe("CredentialManager", () => {
  beforeEach(() => {
    replies = { vault_exists: { value: true }, vault_is_unlocked: { value: true }, settings_get: { value: {} }, credential_list: { value: CREDENTIALS } };
    useVaultStore.setState({ isUnlocked: true, credentials: CREDENTIALS });
  });

  it("keeps its title, count, search, Add, rows and footer note; Escape closes, scrim does not", async () => {
    const onClose = vi.fn();
    await show(<CredentialManager onClose={onClose} />);
    expect(title()).toBe("Credentials");
    expect(screen.getByText("2 stored").closest("[data-cv-dialog-subtitle]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Lock vault" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search credentials...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    expect(screen.getByText("Domain Admin")).toBeInTheDocument();
    expect(screen.getByText("SSH Key")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Edit credential" })).toHaveLength(2);
    expect(screen.getByText("Credentials are encrypted with AES-256-GCM")).toBeInTheDocument();
    expectCloseBehavior(onClose, { escape: true, scrim: false, button: true });
  });

  it("does not close on Escape while its form or a delete confirm is open", async () => {
    const onClose = vi.fn();
    await show(<CredentialManager onClose={onClose} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete credential" })[0]);
    expect(screen.getByText('Delete "Domain Admin"?')).toBeInTheDocument();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("heading", { name: "New Credential" })).toBeInTheDocument();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "New Credential" })).toBeNull();
  });
});

describe("CredentialForm", () => {
  it("keeps every field in order with Cancel then Create; Escape and the close button close, the scrim does not", async () => {
    const onClose = vi.fn();
    await show(<CredentialForm onClose={onClose} onSaved={vi.fn()} />);
    expect(title()).toBe("New Credential");
    const labels = Array.from(dialog().querySelectorAll("span.mb-1.font-semibold")).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Name *", "Type", "Username", "Password", "Domain", "Private Key", "Tags"]);
    expect(within(screen.getByRole("radiogroup", { name: "Type" })).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Generic", "SSH Key"]);
    expect(screen.getByText("One-Time Password (TOTP)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import QR Code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter Secret Key" })).toBeInTheDocument();
    expect(screen.getByTitle("Password Generator")).toBeInTheDocument();
    expect(screen.getByTitle("SSH Key Generator")).toBeInTheDocument();
    expect(footer()).toEqual(["Cancel", "Create"]);
    expectCloseBehavior(onClose, { escape: true, scrim: false, button: true });
  });

  it("submits through its form and titles a preset type", async () => {
    replies = { credential_create: { value: { id: "c9" } }, credential_list: { value: [] } };
    const onSaved = vi.fn();
    await show(<CredentialForm presetType="ssh_key" onClose={vi.fn()} onSaved={onSaved} />);
    expect(title()).toBe("New SSH Key Credential");
    expect(screen.getByText("SSH Key Metadata")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Key" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(invoke).toHaveBeenCalledWith("credential_create", expect.objectContaining({ name: "Key", credential_type: "ssh_key" }));
    expect(onSaved).toHaveBeenCalled();
  });
});

describe("CredentialPicker", () => {
  it("keeps its search, None row and options on the sync layer; Escape, the scrim and the close button close it", async () => {
    useVaultStore.setState({ credentials: CREDENTIALS });
    const onClose = vi.fn();
    const onSelect = vi.fn();
    await show(<CredentialPicker selectedId="c1" onSelect={onSelect} onClose={onClose} />);
    expect(title()).toBe("Select Credential");
    expect(dialog().parentElement).toHaveAttribute("data-cv-layer", "sync");
    expect(screen.getByPlaceholderText("Search credentials...")).toHaveFocus();
    const rows = within(dialog())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label") !== "Close");
    expect(rows.map((b) => b.textContent)).toEqual(["None (use inline credentials)", "Domain AdminadministratorACMEprod", "Deploy KeySSH Keydeploy"]);
    expect(rows[1]).toHaveAttribute("data-selected");
    expectCloseBehavior(onClose, { escape: true, scrim: true, button: true });
    fireEvent.click(rows[2]);
    expect(onSelect).toHaveBeenCalledWith("c2");
  });
});

describe("PasswordHistoryDialog", () => {
  it("lists changes with their actions and keeps the upgrade note before Close; close button only, no Escape, no scrim", async () => {
    replies = {
      password_history_list: { value: [{ id: "h1", entry_id: "e1", username: "admin", password: "old-secret", changed_at: "2026-01-01T10:00:00Z", changed_by: "owner@acme.test" }] },
      vault_get_type: { value: "personal" },
    };
    const onClose = vi.fn();
    await show(<PasswordHistoryDialog entryId="e1" entryName="Domain Admin" onClose={onClose} />);
    expect(title()).toBe("Password History");
    expect(screen.getByText("Domain Admin")).toBeInTheDocument();
    expect(screen.getByText("Changed by owner@acme.test")).toBeInTheDocument();
    for (const name of ["Show password", "Copy password", "Delete history entry"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByText("old-secret")).toBeInTheDocument();
    expect(screen.getByText(/Free plan shows 3 most recent changes\./)).toBeInTheDocument();
    expect(footer()).toEqual(["Upgrade for full history.", "Close"]);
    expectCloseBehavior(onClose, { escape: false, scrim: false, button: true });
  });
});
