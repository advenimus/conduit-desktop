import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { createElement } from "react";

const toasts: { type: string; title: string; message?: unknown }[] = [];
vi.mock("../../components/common/Toast", () => {
  const add = (type: string) => (title: string, message?: unknown) => {
    toasts.push({ type, title, message });
    return "id";
  };
  return { toast: { success: add("success"), info: add("info"), warning: add("warning"), error: add("error"), dismiss: vi.fn(), update: vi.fn() } };
});

const { runStartupVault, goToVaultHubFromStartup } = await import("../startup-vault");
const { useVaultStore } = await import("../../stores/vaultStore");
const { useStartupVaultStore } = await import("../../stores/startupVaultStore");
const { useSyncStore } = await import("../../stores/syncStore");
const { useAuthStore } = await import("../../stores/authStore");
const { default: FullScreenSpinner } = await import("../../components/common/FullScreenSpinner");

const WORK = "/v/Work.conduit";
let replies: Record<string, (args?: unknown) => unknown>;
const calls: string[] = [];
const invoke = vi.fn(async (channel: string, args?: unknown) => {
  calls.push(channel);
  const r = replies[channel];
  return r ? r(args) : undefined;
});
const unlockRequests: string[] = [];

beforeEach(() => {
  toasts.length = 0;
  calls.length = 0;
  unlockRequests.length = 0;
  replies = {
    vault_exists: () => true,
    vault_is_unlocked: () => false,
    vault_get_path: () => WORK,
    settings_get: () => ({ recent_vaults: [WORK], onboarding_completed: true }),
    get_pending_vault_file: () => null,
    vault_open: () => ({ filePath: WORK, exists: true }),
    credential_list: () => [],
  };
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  document.addEventListener("conduit:unlock-vault", onUnlockRequest);
  useVaultStore.setState({ showVaultHub: true, isUnlocked: false, vaultType: "personal", autoConnectError: null });
  useStartupVaultStore.setState({ pending: true, opening: null, fallback: null });
  useSyncStore.setState({ openError: null });
  useAuthStore.setState({ isTeamMember: false, authMode: "local" });
});

function onUnlockRequest() {
  unlockRequests.push("unlock");
}

afterEach(() => {
  document.removeEventListener("conduit:unlock-vault", onUnlockRequest);
  cleanup();
});

describe("runStartupVault (docs/AUTO_UNLOCK.md 4.2)", () => {
  it("hub plan: the hub; a skip or a missing file says so", async () => {
    replies.vault_startup_plan = () => ({ kind: "hub", skipped: { name: "Work" } });
    await runStartupVault();
    expect(useVaultStore.getState().showVaultHub).toBe(true);
    expect(useStartupVaultStore.getState().pending).toBe(false);
    expect(toasts).toEqual([{ type: "info", title: "Startup vault skipped", message: "Conduit opened the Vault Hub. Work opens next time." }]);
    toasts.length = 0;
    replies.vault_startup_plan = () => ({ kind: "hub", missing: { fileName: "Work.conduit", path: WORK } });
    await runStartupVault();
    expect(toasts[0]).toMatchObject({ type: "warning", title: "Couldn't find Work.conduit" });
  });

  it("personal without a saved unlock: opens it and asks for the password", async () => {
    replies.vault_startup_plan = () => ({ kind: "personal", path: WORK, name: "Work", auto: false });
    await runStartupVault();
    expect(calls).toContain("vault_open");
    expect(unlockRequests).toEqual(["unlock"]);
    expect(calls).not.toContain("vault_auto_unlock");
  });

  it("automatic unlock: the vault opens with a toast that offers Turn Off", async () => {
    replies.vault_startup_plan = () => ({ kind: "personal", path: WORK, name: "Work", auto: true });
    replies.vault_auto_unlock = () => {
      replies.vault_is_unlocked = () => true;
      return { ok: true };
    };
    await runStartupVault();
    expect(useVaultStore.getState().showVaultHub).toBe(false);
    expect(toasts[0]).toMatchObject({ type: "info", title: "Work unlocked automatically" });
    expect(useStartupVaultStore.getState().opening).toBeNull();
  });

  it("stale: the unlock prompt with the stale note", async () => {
    replies.vault_startup_plan = () => ({ kind: "personal", path: WORK, name: "Work", auto: true });
    replies.vault_auto_unlock = () => ({ ok: false, fallback: "stale" });
    await runStartupVault();
    expect(useStartupVaultStore.getState().fallback).toEqual({ kind: "stale", name: "Work" });
    expect(unlockRequests).toEqual(["unlock"]);
  });

  it("a gate error from main opens its dialog in the saved form", async () => {
    replies.vault_startup_plan = () => ({ kind: "personal", path: WORK, name: "Work", auto: true });
    replies.vault_auto_unlock = () => {
      throw new Error(JSON.stringify({ code: "VAULT_SIGN_IN_REQUIRED", fileName: "Work.conduit" }));
    };
    await runStartupVault();
    expect(useStartupVaultStore.getState().fallback).toEqual({ kind: "saved", name: "Work" });
  });

  it("Go to Vault Hub cancels the open, shows the hub and says so", async () => {
    let finish: (v: unknown) => void = () => undefined;
    replies.vault_startup_plan = () => ({ kind: "personal", path: WORK, name: "Work", auto: true });
    replies.vault_auto_unlock = () => new Promise((r) => (finish = r));
    const run = runStartupVault();
    await new Promise((r) => setTimeout(r, 5));
    expect(useStartupVaultStore.getState().opening).toEqual({ text: "Opening Work...", cancellable: true });
    goToVaultHubFromStartup();
    expect(calls).toContain("vault_startup_cancel");
    finish({ ok: false, fallback: "not-allowed" });
    await run;
    expect(useVaultStore.getState().showVaultHub).toBe(true);
    expect(unlockRequests).toEqual([]);
    expect(toasts[0]).toMatchObject({ title: "Startup vault skipped" });
  });

  it("a chosen team vault shows the opening screen with Go to Vault Hub; the last team rule does not", async () => {
    useAuthStore.setState({ isTeamMember: true, authMode: "authenticated" });
    replies.identity_key_exists = () => true;
    let opened: (v: unknown) => void = () => undefined;
    replies.team_vault_open = () => new Promise((r) => (opened = r));
    replies.vault_startup_plan = () => ({ kind: "team", teamVaultId: "t1" });
    const run = runStartupVault();
    await new Promise((r) => setTimeout(r, 5));
    expect(useStartupVaultStore.getState().opening).toEqual({ text: "Connecting to team vault...", cancellable: true });
    opened(undefined);
    await run;
    useVaultStore.setState({ vaultType: "personal", isUnlocked: false });
    replies.settings_get = () => ({ onboarding_completed: true, last_vault_type: "team", last_team_vault_id: "t1" });
    replies.vault_startup_plan = () => ({ kind: "automatic" });
    replies.team_vault_open = () => new Promise(() => undefined);
    void runStartupVault();
    await new Promise((r) => setTimeout(r, 5));
    expect(useVaultStore.getState().autoConnectInProgress).toBe(true);
    expect(useStartupVaultStore.getState().opening).toBeNull();
  });

  it("does not plan while onboarding has not finished", async () => {
    replies.settings_get = () => ({ onboarding_completed: false });
    await runStartupVault();
    expect(calls).not.toContain("vault_startup_plan");
  });
});

describe("the opening screen (spec 2.3)", () => {
  it("announces its text and focuses Go to Vault Hub, which Escape also presses", () => {
    const onGoToHub = vi.fn();
    render(createElement(FullScreenSpinner, { text: "Opening Work...", onGoToHub }));
    expect(screen.getByRole("status")).toHaveTextContent("Opening Work...");
    const button = screen.getByRole("button", { name: "Go to Vault Hub" });
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onGoToHub).toHaveBeenCalledTimes(1);
  });
});
