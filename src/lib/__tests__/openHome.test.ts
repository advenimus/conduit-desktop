import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHomeTab, installHomeTabGuard, openHome } from "../openHome";
import { HOME_SESSION_ID } from "../dashboardSessions";
import { useSessionStore, type Session } from "../../stores/sessionStore";
import { findLeaf, getAllLeaves, useLayoutStore } from "../../stores/layoutStore";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useVaultStore } from "../../stores/vaultStore";

// Stores read settings through window.electron while these modules load.
vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

const SHELL: Session = { id: "s-shell", type: "local_shell", title: "Terminal", status: "connected" };
const WEB: Session = { id: "s-web", type: "web", title: "Intranet", status: "connected" };

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const VAULT_IPC: Record<string, unknown> = {
  vault_open: { filePath: "/vaults/other.conduit", exists: true },
  vault_create: "/vaults/new.conduit",
  settings_get: { recent_vaults: [] },
  vault_is_network_path: false,
};

function stubVaultIpc() {
  Object.assign(globalThis, {
    electron: { invoke: async (channel: string) => VAULT_IPC[channel] ?? null, on: () => () => undefined },
  });
}
const sessionIds = () => useSessionStore.getState().sessions.map((s) => s.id);
const firstPane = () => getAllLeaves(useLayoutStore.getState().root)[0];

function setUnlocked(isUnlocked: boolean) {
  useVaultStore.setState({ isUnlocked });
}

function setSidebar(mode: "floating-open" | "docked-open") {
  useSidebarStore.setState({
    isExpanded: true,
    isPinned: mode === "docked-open",
    viewportWidth: 1280,
    expandedWidth: 250,
    rightPanelWidth: 0,
  });
}

beforeEach(() => {
  useSessionStore.getState().clearAll();
  useLayoutStore.getState().resetLayout();
  setUnlocked(true);
});

describe("ensureHomeTab", () => {
  it("adds Home at index 0 of the first pane, even when another pane has focus", () => {
    useSessionStore.getState().addSession(SHELL);
    useLayoutStore.getState().splitPane(firstPane().id, "horizontal");
    const [left, right] = getAllLeaves(useLayoutStore.getState().root);
    useLayoutStore.getState().setFocusedPane(right.id);

    ensureHomeTab();

    expect(sessionIds()).toContain(HOME_SESSION_ID);
    expect(findLeaf(useLayoutStore.getState().root, left.id)?.sessionIds).toEqual([HOME_SESSION_ID, "s-shell"]);
    expect(findLeaf(useLayoutStore.getState().root, right.id)?.sessionIds).toEqual([]);
    expect(useSessionStore.getState().sessions.find((s) => s.id === HOME_SESSION_ID)).toEqual({
      id: HOME_SESSION_ID,
      type: "dashboard",
      title: "Home",
      status: "connected",
    });
  });

  it("adds Home once", () => {
    ensureHomeTab();
    ensureHomeTab();
    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
  });

  it("does nothing while the vault is locked", () => {
    setUnlocked(false);
    ensureHomeTab();
    expect(sessionIds()).toEqual([]);
  });
});

describe("openHome", () => {
  it("creates Home when it is missing and makes it the active tab", () => {
    useSessionStore.getState().addSession(SHELL);
    openHome();
    expect(firstPane().sessionIds).toEqual([HOME_SESSION_ID, "s-shell"]);
    expect(firstPane().activeSessionId).toBe(HOME_SESSION_ID);
    expect(useSessionStore.getState().activeSessionId).toBe(HOME_SESSION_ID);
  });

  it("focuses an existing Home in another pane", () => {
    ensureHomeTab();
    useSessionStore.getState().addSession(SHELL);
    useLayoutStore.getState().splitPane(firstPane().id, "horizontal", "s-shell");
    const [left, right] = getAllLeaves(useLayoutStore.getState().root);
    expect(useLayoutStore.getState().focusedPaneId).toBe(right.id);

    openHome();

    expect(useLayoutStore.getState().focusedPaneId).toBe(left.id);
    expect(useSessionStore.getState().activeSessionId).toBe(HOME_SESSION_ID);
  });

  it("closes a floating side bar", () => {
    setSidebar("floating-open");
    openHome();
    expect(useSidebarStore.getState().isExpanded).toBe(false);
  });

  it("leaves a docked side bar open", () => {
    setSidebar("docked-open");
    openHome();
    expect(useSidebarStore.getState().isExpanded).toBe(true);
  });

  it("does nothing while the vault is locked", () => {
    setUnlocked(false);
    setSidebar("floating-open");
    openHome();
    expect(sessionIds()).toEqual([]);
    expect(useSidebarStore.getState().isExpanded).toBe(true);
  });
});

describe("installHomeTabGuard", () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("adds Home when the vault unlocks", async () => {
    setUnlocked(false);
    uninstall = installHomeTabGuard();
    await flush();
    expect(sessionIds()).toEqual([]);

    setUnlocked(true);
    await flush();
    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
    expect(firstPane().sessionIds).toEqual([HOME_SESSION_ID]);
  });

  it("puts Home back after clearAll and resetLayout while the vault stays unlocked", async () => {
    uninstall = installHomeTabGuard();
    await flush();
    useSessionStore.getState().addSession(SHELL);
    useSessionStore.getState().addSession(WEB);

    useSessionStore.getState().clearAll();
    useLayoutStore.getState().resetLayout();
    await flush();

    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
    expect(firstPane().sessionIds).toEqual([HOME_SESSION_ID]);
    expect(firstPane().activeSessionId).toBe(HOME_SESSION_ID);
  });

  it("does not put Home back during lockVault, which clears the sessions before it locks", async () => {
    uninstall = installHomeTabGuard();
    await flush();
    useSessionStore.getState().addSession(SHELL);

    await useVaultStore.getState().lockVault();
    await flush();

    expect(useVaultStore.getState().isUnlocked).toBe(false);
    expect(sessionIds()).toEqual([]);
    expect(firstPane().sessionIds).toEqual([]);
  });

  it("brings Home back as the only tab after lock and unlock", async () => {
    uninstall = installHomeTabGuard();
    await flush();
    useSessionStore.getState().addSession(SHELL);
    await useVaultStore.getState().lockVault();
    await flush();

    setUnlocked(true);
    await flush();

    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
    expect(firstPane().sessionIds).toEqual([HOME_SESSION_ID]);
  });

  it("does not put Home back during openVault, which clears the sessions of the vault it leaves", async () => {
    stubVaultIpc();
    uninstall = installHomeTabGuard();
    await flush();
    useSessionStore.getState().addSession(SHELL);

    await useVaultStore.getState().openVault("/vaults/other.conduit");
    await flush();

    expect(useVaultStore.getState().isUnlocked).toBe(false);
    expect(sessionIds()).toEqual([]);
    expect(firstPane().sessionIds).toEqual([]);
  });

  it("ends createVault with Home as the only tab, from a locked or an open vault", async () => {
    stubVaultIpc();
    setUnlocked(false);
    uninstall = installHomeTabGuard();
    await useVaultStore.getState().createVault("/vaults/new.conduit", "pw");
    await flush();
    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
    expect(firstPane().sessionIds).toEqual([HOME_SESSION_ID]);

    useSessionStore.getState().addSession(SHELL);
    await useVaultStore.getState().createVault("/vaults/second.conduit", "pw");
    await flush();
    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
    expect(firstPane().sessionIds).toEqual([HOME_SESSION_ID]);
  });

  it("waits out a missing sessions list without throwing, then adds Home", async () => {
    uninstall = installHomeTabGuard();
    await flush();
    expect(() => useSessionStore.setState({ sessions: null as never })).not.toThrow();
    await flush();
    expect(useSessionStore.getState().sessions).toBeNull();
    useSessionStore.setState({ sessions: [] });
    await flush();
    expect(sessionIds()).toEqual([HOME_SESSION_ID]);
  });

  it("stops after uninstall", async () => {
    setUnlocked(false);
    installHomeTabGuard()();
    setUnlocked(true);
    await flush();
    expect(sessionIds()).toEqual([]);
  });
});
