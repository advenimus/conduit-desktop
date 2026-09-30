import { useSyncStore } from "../../stores/syncStore";
import { activeStatus } from "../../stores/sync-reducers";
import type { SyncStateResponse } from "../../types/sync";
import { statusLabel, statusTone, type StatusTone } from "./sync-copy";

export type DashboardRowStatus = "ok" | "error" | "syncing" | "idle" | "disabled";

export interface DeviceSyncRow {
  readonly status: DashboardRowStatus;
  readonly detail: string;
}

const ROW_STATUS: Readonly<Record<StatusTone, DashboardRowStatus>> = {
  ok: "ok",
  busy: "syncing",
  warn: "syncing",
  error: "error",
  off: "disabled",
};

/** Dashboard "Device Sync" row; null when the open vault is not a synced personal vault. */
export function deviceSyncRow(state: SyncStateResponse | null): DeviceSyncRow | null {
  if (state === null || state.vault === null || !state.vault.shared) return null;
  const status = activeStatus(state);
  if (status === null) return { status: "disabled", detail: state.enabled ? "Locked" : "Off" };
  const review = status.conflictCount > 0 ? `, ${status.conflictCount} to review` : "";
  return { status: ROW_STATUS[statusTone(status, state.killSwitch)], detail: `${statusLabel(status, state.killSwitch)}${review}` };
}

export function useDeviceSyncRow(): DeviceSyncRow | null {
  const state = useSyncStore((s) => s.state);
  return deviceSyncRow(state);
}
