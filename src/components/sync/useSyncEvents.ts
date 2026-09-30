import { useEffect } from "react";
import { invoke, listenSync } from "../../lib/electron";
import { useSyncStore } from "../../stores/syncStore";
import { useVaultStore, type SoftLockReason } from "../../stores/vaultStore";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import type {
  ConflictsChangedEvent,
  DisplacedEvent,
  DisplacingEvent,
  OpenWaitingEvent,
  OwnershipChangedEvent,
  SessionConflictEvent,
  SyncNoticeEvent,
  SyncStatus,
} from "../../types/sync";
import { handleSyncNotice } from "./sync-notices";
import { deviceNameOr } from "./sync-copy";

/** Soft-lock reason of a displacement (plan enforcement 4.4): device_cap reads as open elsewhere. */
function softLockReason(ev: DisplacedEvent): SoftLockReason {
  return ev.reason === "not_owner" || ev.reason === "update_required" ? ev.reason : "open_elsewhere";
}

/** Displaced: lock the vault view but keep sessions, tabs and layout (soft lock). */
function onDisplaced(ev: DisplacedEvent): void {
  useSyncStore.getState().setDisplacing(null);
  useVaultStore.getState().setSoftLocked(softLockReason(ev));
  useEntryStore.getState().clearSelection();
  useEntryStore.setState({ entries: [], folders: [] });
  if (ev.reason === "yielded") {
    toast.info("Vault locked on this device.", `It stays open on ${deviceNameOr(ev.byDeviceName)}.`);
    return;
  }
  useSyncStore.getState().setDisplaced(ev);
}

/** The open vault's file moved (spec 5.9 rebind, Locate, rename): the title and recent list follow. */
function onVaultPathChanged(ev: { path?: unknown } | null): void {
  if (typeof ev?.path !== "string" || ev.path === "") return;
  useVaultStore.setState({ currentVaultPath: ev.path });
  invoke<{ recent_vaults?: string[] }>("settings_get")
    .then((s) => useVaultStore.setState({ recentVaults: s.recent_vaults ?? [] }))
    .catch((err) => console.error("[sync] Failed to reload recent vaults:", err));
}

function subscribeMainEvents(): Array<() => void> {
  const store = useSyncStore.getState;
  return [
    listenSync<SyncStatus>("sync:state-changed", (e) => store().applyStatus(e.payload)),
    listenSync<ConflictsChangedEvent>("sync:conflicts-changed", (e) => store().applyConflictsChanged(e.payload)),
    listenSync<SyncNoticeEvent>("sync:notice", (e) => handleSyncNotice(e.payload)),
    listenSync<OpenWaitingEvent>("sync:open-waiting", (e) => store().setOpenWaiting(e.payload?.waiting ?? null)),
    listenSync<OwnershipChangedEvent>("vault:session-ownership", () => void store().refresh()),
    listenSync<DisplacingEvent>("vault:session-displacing", (e) => store().setDisplacing(e.payload)),
    listenSync<DisplacedEvent>("vault:session-displaced", (e) => onDisplaced(e.payload)),
    listenSync<SessionConflictEvent>("vault:session-conflict", (e) => store().setSessionConflict(e.payload)),
    listenSync<{ path?: unknown } | null>("vault:path-changed", (e) => onVaultPathChanged(e.payload)),
  ];
}

/**
 * Wires every personal-sync event of the main process into the stores, and refreshes
 * `sync_get_state` on unlock, lock and window focus. Mount once (SyncLayer).
 */
export function useSyncEvents(): void {
  useEffect(() => {
    const unlisteners = subscribeMainEvents();
    const refresh = () => void useSyncStore.getState().refresh();
    window.addEventListener("focus", refresh);
    const unsubVault = useVaultStore.subscribe((s, prev) => {
      if (s.isUnlocked !== prev.isUnlocked || s.currentVaultPath !== prev.currentVaultPath) refresh();
    });
    refresh();
    return () => {
      unlisteners.forEach((un) => un());
      window.removeEventListener("focus", refresh);
      unsubVault();
    };
  }, []);
}
