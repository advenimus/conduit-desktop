/**
 * The renderer part of the startup sequence (docs/AUTO_UNLOCK.md 4.2): runs once sign-in has
 * settled, asks main for the plan (main owns the one-shot) and shows the Vault Hub, the last or
 * chosen team vault, the unlock prompt, or the "Opening..." screen of an automatic unlock with
 * its fallbacks. A module flag stops a second run inside one mount; main is the real guard.
 */

import { invoke } from "./electron";
import { errorText } from "./errorText";
import { toast } from "../components/common/Toast";
import { useAuthStore } from "../stores/authStore";
import { useEntryStore } from "../stores/entryStore";
import { useSyncStore } from "../stores/syncStore";
import { useTeamStore } from "../stores/teamStore";
import { useVaultStore } from "../stores/vaultStore";
import { classifyUnlockError } from "../stores/vault-unlock-errors";
import { unlockSucceeded } from "../stores/vault-sync-hooks";
import { useStartupVaultStore, type AutoUnlockOutcome, type StartupChoice } from "../stores/startupVaultStore";
import { toastAccountChanged, toastAutoUnlockOff, toastSkipped, toastStartupCleared, vaultFileName, vaultName } from "./startup-vault-copy";

export type StartupPlan =
  | { readonly kind: "none" }
  | { readonly kind: "hub"; readonly skipped?: { readonly name: string | null }; readonly missing?: { readonly fileName: string; readonly path: string } }
  | { readonly kind: "automatic" }
  | { readonly kind: "team"; readonly teamVaultId: string }
  | { readonly kind: "personal"; readonly path: string; readonly name: string; readonly auto: boolean };

interface StartupSettings {
  readonly onboarding_completed?: boolean;
  readonly last_vault_type?: string | null;
  readonly last_team_vault_id?: string | null;
}

let running = false;
let cancelOpening: (() => void) | null = null;

function showHub(): void {
  useVaultStore.getState().setShowVaultHub(true);
}

function promptUnlock(): void {
  showHub();
  document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
}

async function stopOpeningAtStartup(name: string): Promise<void> {
  try {
    const { forgot } = await useStartupVaultStore.getState().setStartup({ kind: "hub" });
    toastStartupCleared(name, forgot);
  } catch (err) {
    toast.error("Couldn't change the startup vault", errorText(err, "Try again in Settings > General."));
  }
}

export async function turnOffAutoUnlock(name: string): Promise<void> {
  try {
    await useStartupVaultStore.getState().disable();
    toastAutoUnlockOff(name);
  } catch (err) {
    toast.error("Couldn't turn off automatic unlock", errorText(err, "Try again in Settings > Security."));
  }
}

function toastMissing(fileName: string, name: string): void {
  toast.warning(`Couldn't find ${fileName}`, {
    message: "It may have been moved or renamed. Conduit opened the Vault Hub.",
    duration: 10_000,
    actions: [
      { label: "Open Vault File...", onClick: () => document.dispatchEvent(new CustomEvent("conduit:open-vault")) },
      { label: "Stop Opening at Startup", onClick: () => void stopOpeningAtStartup(name) },
    ],
  });
}

/** Cancel on a fallback dialog of an automatic attempt: the Hub, and a way to stop it for good. */
export function toastStartupOpenCancelled(name: string): void {
  void invoke("vault_startup_done").catch(() => undefined);
  toast.info(`${name} didn't open`, {
    message: "It will try again at the next start.",
    actions: [{ label: "Stop Opening at Startup", onClick: () => void stopOpeningAtStartup(name) }],
  });
}

/** "Go to Vault Hub" on the opening screen. */
export function goToVaultHubFromStartup(): void {
  cancelOpening?.();
}

async function finishUnlocked(): Promise<void> {
  const vault = useVaultStore.getState();
  await vault.checkVaultStatus();
  useEntryStore.getState().loadAll();
  vault.setShowVaultHub(false);
}

async function followFallback(fallback: Exclude<AutoUnlockOutcome, { ok: true }>["fallback"], path: string, name: string): Promise<void> {
  const vault = useVaultStore.getState();
  const startup = useStartupVaultStore.getState();
  if (fallback === "missing-file") {
    showHub();
    toastMissing(vaultFileName(path), name);
    return;
  }
  if (fallback === "not-allowed") {
    await vault.openVault(path);
    promptUnlock();
    return;
  }
  await vault.checkVaultStatus();
  if (fallback === "account") toastAccountChanged();
  else startup.setFallback({ kind: fallback, name });
  promptUnlock();
}

async function openAutomatically(path: string, name: string): Promise<void> {
  const startup = useStartupVaultStore.getState();
  let cancelled = false;
  cancelOpening = () => {
    cancelled = true;
    startup.setOpening(null);
    showHub();
    toastSkipped(name);
    void invoke("vault_startup_cancel").catch(() => undefined);
  };
  startup.setOpening({ text: `Opening ${name}...`, cancellable: true });
  try {
    const res = await invoke<AutoUnlockOutcome>("vault_auto_unlock", {});
    if (cancelled) return;
    if (res.ok) {
      unlockSucceeded((partial) => useVaultStore.setState(partial));
      await finishUnlocked();
      void startup.refresh();
      toast.info(`${name} unlocked automatically`, { actions: [{ label: "Turn Off", onClick: () => void turnOffAutoUnlock(name) }] });
    } else {
      await followFallback(res.fallback, path, name);
    }
  } catch (err) {
    if (cancelled) return;
    await useVaultStore.getState().checkVaultStatus();
    const { payload, message } = classifyUnlockError(err, "Conduit couldn't open the vault.");
    useSyncStore.getState().setOpenError(payload);
    useVaultStore.setState({ error: message });
    startup.setFallback({ kind: "saved", name });
    promptUnlock();
  } finally {
    cancelOpening = null;
    if (!cancelled) startup.setOpening(null);
  }
}

function teamReady(): Promise<boolean> {
  const { isTeamMember, authMode } = useAuthStore.getState();
  if (!isTeamMember || authMode !== "authenticated") return Promise.resolve(false);
  return invoke<boolean>("identity_key_exists").catch(() => false);
}

/** Today's rule: reconnect to the last team vault used, with the full-screen spinner. */
async function connectLastTeamVault(settings: StartupSettings): Promise<void> {
  const vault = useVaultStore.getState();
  if (settings.last_vault_type !== "team" || !settings.last_team_vault_id || !(await teamReady())) {
    showHub();
    return;
  }
  vault.setAutoConnectInProgress(true);
  vault.setShowVaultHub(false);
  try {
    await vault.openTeamVault(settings.last_team_vault_id);
    useEntryStore.getState().loadAll();
    vault.setAutoConnectInProgress(false);
    vault.setShowVaultHub(false);
  } catch (err) {
    vault.setAutoConnectInProgress(false);
    vault.setAutoConnectError(errorText(err, "Failed to auto-connect to team vault"));
    vault.setShowVaultHub(true);
  }
}

/** A team vault chosen in Settings: the same connect, with "Go to Vault Hub" on the opening screen. */
export async function connectChosenTeamVault(teamVaultId: string): Promise<void> {
  const vault = useVaultStore.getState();
  const startup = useStartupVaultStore.getState();
  if (!(await teamReady())) {
    vault.setAutoConnectError(
      useAuthStore.getState().authMode === "cached"
        ? "You're offline, so Conduit couldn't open the team vault chosen for startup."
        : "Conduit couldn't open the team vault chosen for startup.",
    );
    showHub();
    return;
  }
  let cancelled = false;
  cancelOpening = () => {
    cancelled = true;
    startup.setOpening(null);
    showHub();
    toastSkipped(useTeamStore.getState().teamVaults.find((t) => t.id === teamVaultId)?.name ?? null);
  };
  startup.setOpening({ text: "Connecting to team vault...", cancellable: true });
  try {
    await vault.openTeamVault(teamVaultId);
    if (cancelled) {
      await useVaultStore.getState().closeTeamVault();
      return;
    }
    useEntryStore.getState().loadAll();
    vault.setShowVaultHub(false);
  } catch (err) {
    if (cancelled) return;
    vault.setAutoConnectError(errorText(err, "Failed to connect to the team vault"));
    showHub();
  } finally {
    cancelOpening = null;
    if (!cancelled) startup.setOpening(null);
  }
}

async function follow(plan: StartupPlan, settings: StartupSettings): Promise<void> {
  switch (plan.kind) {
    case "none":
      showHub();
      return;
    case "hub":
      showHub();
      if (plan.missing) toastMissing(plan.missing.fileName, vaultName(plan.missing.path));
      else if (plan.skipped) toastSkipped(plan.skipped.name);
      return;
    case "automatic":
      await connectLastTeamVault(settings);
      return;
    case "team":
      await connectChosenTeamVault(plan.teamVaultId);
      return;
    case "personal":
      if (plan.auto) {
        await openAutomatically(plan.path, plan.name);
      } else {
        await useVaultStore.getState().openVault(plan.path);
        promptUnlock();
      }
  }
}

async function openPendingFile(): Promise<boolean> {
  const pendingFile = await invoke<string | null>("get_pending_vault_file").catch(() => null);
  if (!pendingFile) return false;
  void invoke("vault_startup_done").catch(() => undefined);
  const vaultState = useVaultStore.getState();
  await vaultState.openVault(pendingFile);
  vaultState.setShowVaultHub(false);
  document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
  return true;
}

/** Steps 6 to 8 of spec 4.2, and what the plan says. Also runs when the window shows again after a close. */
export async function runStartupVault(): Promise<void> {
  if (running) return;
  running = true;
  const startup = useStartupVaultStore.getState();
  try {
    const vaultState = useVaultStore.getState();
    await vaultState.checkVaultStatus();
    void startup.refresh();
    if (useVaultStore.getState().isUnlocked || vaultState.vaultType === "team") {
      useEntryStore.getState().loadAll();
      vaultState.setShowVaultHub(false);
      return;
    }
    if (await openPendingFile()) return;
    const settings = await invoke<StartupSettings>("settings_get").catch((): StartupSettings => ({}));
    if (settings.onboarding_completed === false) {
      showHub();
      return;
    }
    await follow(await invoke<StartupPlan>("vault_startup_plan"), settings);
  } catch (err) {
    console.error("[startup-vault] startup failed; showing the Vault Hub", err);
    showHub();
  } finally {
    running = false;
    startup.setPending(false);
  }
}

/** Where the Settings select and the Hub menu put the choice, in main's shape. */
export function choiceFor(value: string): StartupChoice {
  if (value === "automatic") return { kind: "automatic" };
  if (value === "hub") return { kind: "hub" };
  if (value.startsWith("t:")) return { kind: "team", teamVaultId: value.slice(2) };
  return { kind: "personal", path: value.slice(2) };
}

let reportersInstalled = false;
let lastPresence = 0;
const PRESENCE_THROTTLE_MS = 1_000;

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type));
}

/**
 * Tells main when a text field takes focus (Shift from then on is typing, not the escape hatch)
 * and when a person clicks or types (the MCP hold of spec 4.8 ends).
 */
export function installStartupInputReporters(): void {
  if (reportersInstalled) return;
  reportersInstalled = true;
  let focusReported = false;
  document.addEventListener("focusin", (e) => {
    if (focusReported || !isTextField(e.target)) return;
    focusReported = true;
    void invoke("startup_input_focus").catch(() => undefined);
  });
  const present = (kind: "pointer" | "key") => (e: Event) => {
    if (!e.isTrusted) return;
    const now = Date.now();
    if (now - lastPresence < PRESENCE_THROTTLE_MS) return;
    lastPresence = now;
    void invoke("startup_user_present", { kind }).catch(() => undefined);
  };
  document.addEventListener("pointerdown", present("pointer"), true);
  document.addEventListener("keydown", present("key"), true);
}

/** The sign-in screen or onboarding is showing: Shift there is typing. */
export function reportInputScreen(): void {
  void invoke("startup_input_focus").catch(() => undefined);
}
