import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Pair = { hook: string; legacy: string | null; probe?: string };
type Helpers = {
  usesHook(scope: ParentNode | null, pair: Pair): boolean;
  pickOne(scope: ParentNode | null, pair: Pair, legacyScope?: ParentNode | null): Element | null;
  pickAll(scope: ParentNode | null, pair: Pair): Element[];
  pickClosest(el: Element, scope: ParentNode, pair: Pair): Element | null;
};
// The harness is plain .mjs without type declarations.
const { SELECTORS: S, helpers: cv } = (await import("../../../../scripts/verify/lib/selectors.mjs" as string)) as {
  SELECTORS: Record<string, Pair>;
  helpers: Helpers;
};
const { clickToggleInPage } = (await import("../../../../scripts/verify/lib/backup-flows.mjs" as string)) as {
  clickToggleInPage(arg: { root: string; label: string }, helpers: Helpers & { S: Record<string, Pair> }): string;
};

const vault = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));
const auth = vi.hoisted(() => ({ state: { user: null as unknown, authMode: "local" } }));
const tier = vi.hoisted(() => ({ cloud: false }));

vi.mock("../../../stores/vaultStore", () => ({ useVaultStore: () => vault.state }));
vi.mock("../../../stores/authStore", () => ({ useAuthStore: () => auth.state }));
vi.mock("../../../stores/aiStore", () => ({
  useAiStore: (select: (s: unknown) => unknown) => select({ tierCapabilities: { cloud_sync_enabled: tier.cloud } }),
}));
vi.mock("../../../lib/electron", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../vault/BackupHistoryPanel", () => ({ default: () => null }));
vi.mock("../../vault/BackupManagerDialog", () => ({ default: () => null }));

import BackupTab from "../tabs/BackupTab";

const BACKUPS = [
  { name: "vault-2026-09-28.conduit.bak", fullPath: "/b/1", created_at: "2026-09-28T10:00:00Z", size: 2048 },
  { name: "vault-2026-09-27.conduit.bak", fullPath: "/b/2", created_at: "2026-09-27T10:00:00Z", size: 1024 },
];

function vaultState(enabled: boolean, cloudEnabled = false) {
  return {
    isUnlocked: true,
    cloudSyncState: { enabled: cloudEnabled, status: "disabled", lastSyncedAt: null, error: null },
    localBackupState: enabled
      ? { enabled: true, backupPath: "/backups", retentionDays: 30, status: "backed-up", lastBackedUpAt: "2026-09-28T10:00:00Z", error: null }
      : { enabled: false, backupPath: null, retentionDays: 30, status: "idle", lastBackedUpAt: null, error: null },
    localBackups: enabled ? BACKUPS : [],
    fetchCloudSyncState: vi.fn(),
    fetchLocalBackupState: vi.fn(),
    listLocalBackups: vi.fn(),
    setLocalBackupState: vi.fn(),
    enableLocalBackup: vi.fn(async () => {}),
    disableLocalBackup: vi.fn(async () => {}),
    localBackupNow: vi.fn(async () => {}),
    deleteLocalBackup: vi.fn(async () => {}),
    updateLocalBackupSettings: vi.fn(),
    selectLocalBackupFolder: vi.fn(async () => "/picked"),
    enableCloudSync: vi.fn(async () => {}),
    disableCloudSync: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    deleteCloudVault: vi.fn(async () => {}),
  };
}

const ROOT = "[data-cv-settings]";
const scope = () => document.querySelector<HTMLElement>(ROOT)!;
const renderTab = () => render(<div data-cv-settings=""><BackupTab /></div>);

// jsdom has no innerText, which the harness's in-page code reads; textContent stands in for it.
const hadInnerText = "innerText" in HTMLElement.prototype;
beforeAll(() => {
  if (!hadInnerText) {
    Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent ?? ""; } });
  }
});
afterAll(() => {
  if (!hadInnerText) delete (HTMLElement.prototype as { innerText?: string }).innerText;
});

beforeEach(() => {
  vault.state = vaultState(false);
  auth.state = { user: null, authMode: "local" };
  tier.cloud = false;
});

describe("Settings > Backup hooks (B22, B23, B24, B39, B40, B41)", () => {
  it("keeps the Local Backup <label> with its Switch a direct child of the toggle row, and the harness clicks it", async () => {
    renderTab();
    const label = [...scope().querySelectorAll("label")].find((l) => l.textContent === "Local Backup")!;
    const row = cv.pickClosest(label, scope(), S.toggleRow)!;
    expect(row).toHaveAttribute("data-cv-toggle-row");
    const toggle = cv.pickOne(row, S.toggle)!;
    expect(toggle.parentElement).toBe(row);
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(label).toHaveAttribute("for", toggle.id);

    await act(async () => {
      expect(clickToggleInPage({ root: ROOT, label: "Local Backup" }, { ...cv, S })).toBe("clicked");
    });
    const state = vault.state as ReturnType<typeof vaultState>;
    expect(state.selectLocalBackupFolder).toHaveBeenCalled();
    expect(state.enableLocalBackup).toHaveBeenCalledWith("/picked");
  });

  it("lists the backup files through their hooks", () => {
    vault.state = vaultState(true);
    renderTab();
    expect(cv.usesHook(scope(), S.backupFiles)).toBe(true);
    const list = scope().querySelector(S.backupFiles.hook);
    const rows = cv.pickAll(list, S.backupRow);
    expect(rows).toHaveLength(2);
    expect(cv.pickOne(rows[0], S.backupName)?.textContent).toBe("vault-2026-09-28.conduit.bak");
    expect(cv.pickOne(rows[0], S.backupMeta)?.textContent).toMatch(/ - 2 KB$/);
    expect(screen.getByText("Backup Files (2)").tagName).toBe("LABEL");
    expect(screen.getByRole("button", { name: "Backup Now" })).toBeEnabled();
  });

  it("asks before deleting a backup file", async () => {
    vault.state = vaultState(true);
    renderTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete backup" })[0]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    });
    expect((vault.state as ReturnType<typeof vaultState>).deleteLocalBackup).toHaveBeenCalledWith("/b/1");
  });

  it("badges a Free user's Cloud Backup section and disables its toggle", () => {
    auth.state = { user: { id: "u" }, authMode: "authenticated" };
    renderTab();
    const label = [...scope().querySelectorAll("label")].find((l) => l.textContent === "Cloud Backup")!;
    const section = cv.pickClosest(label, scope(), S.cloudBackupSection)!;
    expect(section).toHaveAttribute("data-cv-cloud-backup-section");
    expect(cv.pickOne(scope(), S.cloudBackupBadge, label.parentElement)?.textContent).toBe("Pro and Team");
    const toggle = cv.pickOne(cv.pickClosest(label, scope(), S.toggleRow), S.toggle) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(clickToggleInPage({ root: ROOT, label: "Cloud Backup" }, { ...cv, S })).toBe("disabled");
  });

  it("shows no badge on a plan with cloud backup", () => {
    auth.state = { user: { id: "u" }, authMode: "authenticated" };
    tier.cloud = true;
    vault.state = vaultState(false, true);
    renderTab();
    expect(cv.pickOne(scope(), S.cloudBackupBadge)).toBeNull();
    expect(screen.getByRole("button", { name: "Back Up Now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Cloud Backup" })).toBeInTheDocument();
  });
});
