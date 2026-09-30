/**
 * The recent-vault and team-vault context menus of the Vault Hub and the vault menu (docs/AUTO_UNLOCK.md
 * 2.6), so both stay the same. A change that would forget a saved unlock asks first through the
 * store's confirm slot, which StartupConfirmHost renders.
 */

import type React from "react";
import { showContextMenu, type PopupMenuItem } from "../../utils/contextMenu";
import { useStartupVaultStore, type StartupChoice, type StartupStatus } from "../../stores/startupVaultStore";
import { useVaultStore } from "../../stores/vaultStore";
import type { TeamVaultSummary } from "../../stores/teamStore";
import { errorText } from "../../lib/errorText";
import { turnOffAutoUnlock } from "../../lib/startup-vault";
import { toastAutoUnlockOff, toastStartupCleared, toastStartupSet, vaultName } from "../../lib/startup-vault-copy";
import { toast } from "../common/Toast";

const SEPARATOR: PopupMenuItem = { id: "sep", label: "", type: "separator" };

async function currentStatus(): Promise<StartupStatus | null> {
  return useStartupVaultStore.getState().status ?? (await useStartupVaultStore.getState().refresh());
}

async function setStartup(choice: StartupChoice, name: string, previousSaved: string | null): Promise<void> {
  try {
    const { forgot } = await useStartupVaultStore.getState().setStartup(choice);
    if (choice.kind === "hub") {
      toastStartupCleared(name, forgot);
      return;
    }
    if (forgot && previousSaved) toastAutoUnlockOff(vaultName(previousSaved));
    toastStartupSet(name);
  } catch (err) {
    toast.error("Couldn't change the startup vault", errorText(err, "Try again in Settings > General."));
  }
}

/** "Open at Startup", after the confirm when another vault unlocks automatically (spec 2.4). */
function openAtStartup(status: StartupStatus | null, choice: StartupChoice, name: string): void {
  const saved = status?.savedPath ?? null;
  const same = choice.kind === "personal" && choice.path === saved;
  if (saved === null || same) {
    void setStartup(choice, name, saved);
    return;
  }
  useStartupVaultStore.getState().askConfirm({
    title: "Turn off automatic unlock?",
    message: `${vaultName(saved)} unlocks automatically at startup. Choosing another startup vault turns that off and forgets the saved password.`,
    confirmLabel: "Continue",
    run: () => setStartup(choice, name, saved),
  });
}

export async function openRecentVaultMenu(e: React.MouseEvent, vaultPath: string): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const status = await currentStatus();
  const sv = status?.startupVault;
  const isStartup = sv?.kind === "personal" && sv.path === vaultPath;
  const saved = status?.savedPath === vaultPath;
  const name = vaultName(vaultPath);
  const selected = await showContextMenu(e.clientX, e.clientY, [
    isStartup ? { id: "stop", label: "Stop Opening at Startup", icon: "ban" } : { id: "start", label: "Open at Startup", icon: "rocket" },
    ...(saved ? [{ id: "off", label: "Turn Off Automatic Unlock", icon: "lock" } as PopupMenuItem] : []),
    SEPARATOR,
    { id: "remove", label: "Remove from Recents", icon: "close" },
    { ...SEPARATOR, id: "sep2" },
    { id: "copy", label: "Copy Path", icon: "copy" },
  ]);
  if (selected === "start") openAtStartup(status, { kind: "personal", path: vaultPath }, name);
  else if (selected === "stop") await setStartup({ kind: "hub" }, name, null);
  else if (selected === "off") await turnOffAutoUnlock(name);
  else if (selected === "remove") {
    await useVaultStore.getState().removeRecentVault(vaultPath);
    await useStartupVaultStore.getState().refresh();
    if (isStartup) toastStartupCleared(name, saved);
  } else if (selected === "copy") {
    await navigator.clipboard.writeText(vaultPath);
  }
}

export async function openTeamVaultMenu(e: React.MouseEvent, vault: TeamVaultSummary): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const status = await currentStatus();
  const sv = status?.startupVault;
  const isStartup = sv?.kind === "team" && sv.teamVaultId === vault.id;
  const selected = await showContextMenu(e.clientX, e.clientY, [
    isStartup ? { id: "stop", label: "Stop Opening at Startup", icon: "ban" } : { id: "start", label: "Open at Startup", icon: "rocket" },
  ]);
  if (selected === "start") openAtStartup(status, { kind: "team", teamVaultId: vault.id }, vault.name);
  else if (selected === "stop") await setStartup({ kind: "hub" }, vault.name, null);
}

/** Hub "Clear All": asks first only when it would forget a saved unlock (spec 2.6). */
export async function clearRecentVaultsWithConfirm(): Promise<void> {
  const status = await currentStatus();
  const sv = status?.startupVault;
  const startupName = sv?.kind === "personal" ? vaultName(sv.path) : null;
  const saved = status?.savedPath ?? null;
  const clear = async () => {
    await useVaultStore.getState().clearRecentVaults();
    await useStartupVaultStore.getState().refresh();
    if (startupName) toastStartupCleared(startupName, saved !== null);
  };
  if (saved === null) {
    await clear();
    return;
  }
  useStartupVaultStore.getState().askConfirm({
    title: "Clear recent vaults?",
    message: `${vaultName(saved)} unlocks automatically at startup. Clearing the list turns that off.`,
    confirmLabel: "Clear All",
    run: clear,
  });
}
