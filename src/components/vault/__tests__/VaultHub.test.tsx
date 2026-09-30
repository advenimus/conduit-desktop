import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import VaultHub from "../VaultHub";
import { useVaultStore } from "../../../stores/vaultStore";
import { useSyncStore } from "../../../stores/syncStore";
import { useAuthStore } from "../../../stores/authStore";
import { useTeamStore } from "../../../stores/teamStore";
import type { SyncStateResponse } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const ACME = "/tmp/vaults/Acme Infrastructure.conduit";
const SCRATCH = "/tmp/vaults/Scratch.conduit";

const nextTask = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));

function pendingState(path: string): SyncStateResponse {
  return {
    enabled: true,
    killSwitch: false,
    vault: null,
    status: null,
    deviceLimit: null,
    sideFiles: [],
    notices: [],
    pendingVaults: [{ lineageId: "L", sharedPath: path, fileName: "Acme Infrastructure.conduit" }],
    softLocked: false,
    ownership: null,
    deviceCap: null,
  } as unknown as SyncStateResponse;
}

/** The row's clickable button: the harness finds it by its path (B26, B44). */
const rowButton = (path: string) => document.querySelector(`button[title="${path}"]`) as HTMLButtonElement | null;

/** True when no ancestor up to the row hides the element with opacity 0 (L-23, B45). */
function shownWithoutHover(el: Element, row: Element): boolean {
  for (let node: Element | null = el; node && node !== row.parentElement; node = node.parentElement) {
    if (node.classList.contains("opacity-0")) return false;
  }
  return true;
}

beforeEach(() => {
  invoke.mockImplementation(async (channel, args) => {
    if (channel === "biometric_enabled_for_path") return (args as { vaultPath: string }).vaultPath === ACME;
    return undefined;
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useVaultStore.setState({ recentVaults: [], autoConnectError: null, isLoading: false });
  useAuthStore.setState({ authMode: "local", isTeamMember: false });
  useTeamStore.setState({ teamVaults: [], isLoading: false });
  useSyncStore.setState({ state: null });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  useSyncStore.setState({ state: null });
});

describe("VaultHub (spec 3.11)", () => {
  it("keeps the landing texts and actions without recent vaults", async () => {
    render(<VaultHub />);
    await nextTask();
    expect(screen.getByRole("heading", { level: 1, name: "Conduit" })).toBeInTheDocument();
    expect(screen.getByText("Select a vault to get started")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Vault" })).toHaveAttribute("data-cv-text-button");
    expect(screen.getByRole("button", { name: "Open Vault File" })).toBeInTheDocument();
    expect(screen.queryByText("Recent Vaults")).toBeNull();
  });

  it("draws each recent vault as a clickable row titled with its path, name then folder", async () => {
    useVaultStore.setState({ recentVaults: [SCRATCH, ACME] });
    render(<VaultHub />);
    await nextTask();
    expect(screen.getByRole("heading", { level: 2, name: "Recent Vaults" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear All" })).toBeInTheDocument();
    const rows = [...document.querySelectorAll('button[title$=".conduit"]')].map((b) => b.getAttribute("title"));
    expect(rows).toEqual([SCRATCH, ACME]);
    const acme = rowButton(ACME) as HTMLButtonElement;
    expect(acme.textContent).toContain("Acme Infrastructure");
    expect(acme.textContent).toContain("/tmp/vaults");
    expect(acme.className).toContain("h-row-2line");
  });

  it("shows the pending badge and the fingerprint in the row's meta, visible without hover", async () => {
    useVaultStore.setState({ recentVaults: [ACME] });
    useSyncStore.setState({ state: pendingState(ACME) });
    render(<VaultHub />);
    await nextTask();
    const row = rowButton(ACME) as HTMLButtonElement;
    const badge = screen.getByText("Changes not yet synced");
    expect(row.contains(badge)).toBe(true);
    expect(shownWithoutHover(badge, row)).toBe(true);
    const fingerprint = row.querySelector(".text-info svg, svg.text-info");
    expect(fingerprint).not.toBeNull();
    expect(shownWithoutHover(fingerprint as Element, row)).toBe(true);
  });

  it("keeps only the chevron hover-revealed, outside the row button, hidden by opacity only", async () => {
    useVaultStore.setState({ recentVaults: [ACME] });
    render(<VaultHub />);
    await nextTask();
    const row = rowButton(ACME) as HTMLButtonElement;
    const trailing = row.parentElement?.querySelector(":scope > span.opacity-0") as HTMLElement;
    expect(trailing).not.toBeNull();
    expect(row.contains(trailing)).toBe(false);
    expect(trailing.querySelectorAll("svg")).toHaveLength(1);
    expect(trailing.className).not.toMatch(/\b(hidden|invisible)\b/);
  });

  it("opens a recent vault on click", async () => {
    const openVault = vi.fn(async () => {});
    useVaultStore.setState({ recentVaults: [ACME], openVault, vaultType: "personal" });
    const unlock = vi.fn();
    document.addEventListener("conduit:unlock-vault", unlock);
    render(<VaultHub />);
    await nextTask();
    await act(async () => {
      fireEvent.click(rowButton(ACME) as HTMLButtonElement);
    });
    expect(openVault).toHaveBeenCalledWith(ACME);
    expect(unlock).toHaveBeenCalledTimes(1);
    document.removeEventListener("conduit:unlock-vault", unlock);
  });
});

describe("VaultHub startup vault marks (docs/AUTO_UNLOCK.md 2.6)", () => {
  const status = (over: Record<string, unknown>) => ({
    platform: "darwin",
    store: { usable: true, reason: "ok", storeName: "system keychain" },
    startupVault: { kind: "personal", path: ACME, lineageId: "L1" },
    savedPath: null,
    currentOn: false,
    ...over,
  });

  it("marks the startup vault with a Startup badge and the open-lock icon with screen reader text", async () => {
    invoke.mockImplementation(async (channel) => (channel === "auto_unlock_status" ? status({ savedPath: ACME }) : undefined));
    useVaultStore.setState({ recentVaults: [SCRATCH, ACME] });
    render(<VaultHub />);
    await nextTask();
    const acme = rowButton(ACME) as HTMLButtonElement;
    expect(acme).toHaveTextContent("Startup");
    expect(acme.querySelector('[title="Unlocks automatically on this computer"]')).not.toBeNull();
    expect(acme.querySelector(".sr-only")).toHaveTextContent("Unlocks automatically on this computer");
    expect(rowButton(SCRATCH)).not.toHaveTextContent("Startup");
  });

  it("Clear All asks first only when it would forget a saved unlock", async () => {
    invoke.mockImplementation(async (channel) => (channel === "auto_unlock_status" ? status({ savedPath: ACME }) : channel === "settings_clear_recent_vaults" ? [] : undefined));
    useVaultStore.setState({ recentVaults: [ACME] });
    const { default: StartupConfirmHost } = await import("../StartupConfirmHost");
    render(
      <>
        <VaultHub />
        <StartupConfirmHost />
      </>,
    );
    await nextTask();
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    await nextTask();
    expect(screen.getByRole("heading", { name: "Clear recent vaults?" })).toBeInTheDocument();
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("settings_clear_recent_vaults");
    const clearButtons = screen.getAllByRole("button", { name: "Clear All" });
    fireEvent.click(clearButtons[clearButtons.length - 1]);
    await nextTask();
    expect(invoke.mock.calls.map((c) => c[0])).toContain("settings_clear_recent_vaults");
  });

  it("Clear All is one click without a saved unlock", async () => {
    invoke.mockImplementation(async (channel) => (channel === "auto_unlock_status" ? status({ savedPath: null }) : channel === "settings_clear_recent_vaults" ? [] : undefined));
    useVaultStore.setState({ recentVaults: [ACME] });
    render(<VaultHub />);
    await nextTask();
    fireEvent.click(screen.getByRole("button", { name: "Clear All" }));
    await nextTask();
    expect(invoke.mock.calls.map((c) => c[0])).toContain("settings_clear_recent_vaults");
  });

  it("the row menu offers the startup actions and runs them through main", async () => {
    let menuItems: { id: string; label: string }[] = [];
    invoke.mockImplementation(async (channel, args) => {
      if (channel === "auto_unlock_status") return status({ savedPath: ACME });
      if (channel === "show_context_menu_popup") {
        menuItems = (args as { items: { id: string; label: string }[] }).items;
        return "stop";
      }
      if (channel === "startup_vault_set") return { status: status({ startupVault: { kind: "hub" } }), forgot: true };
      return undefined;
    });
    useVaultStore.setState({ recentVaults: [ACME] });
    render(<VaultHub />);
    await nextTask();
    fireEvent.contextMenu(rowButton(ACME) as HTMLButtonElement);
    await nextTask();
    expect(menuItems.map((i) => i.label).filter(Boolean)).toEqual(["Stop Opening at Startup", "Turn Off Automatic Unlock", "Remove from Recents", "Copy Path"]);
    expect(invoke.mock.calls.find((c) => c[0] === "startup_vault_set")?.[1]).toEqual({ kind: "hub" });
  });
});
