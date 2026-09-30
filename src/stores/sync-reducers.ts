/**
 * Pure state updates for the renderer sync store. Every function returns a new value and never
 * mutates its input.
 */

import type {
  ConflictGroup,
  ConflictsChangedEvent,
  LocalNotice,
  SyncPrompt,
  SyncRowKey,
  SyncStateResponse,
  SyncStatus,
  WaitingForDriveState,
} from "../types/sync";

/** Stable string for a row key, used for sets and React keys. */
export function rowKeyString(row: SyncRowKey): string {
  return `${row.tbl}:${row.rowId}`;
}

function sameLineage(state: SyncStateResponse, lineageId: string): boolean {
  return state.vault?.lineageId === lineageId || state.status?.lineageId === lineageId;
}

/**
 * Applies a `sync:state-changed` payload. Returns null when the event cannot be placed
 * (no state yet, or another vault), so the caller refreshes from `sync_get_state`.
 */
export function withStatus(prev: SyncStateResponse | null, status: SyncStatus): SyncStateResponse | null {
  if (prev === null || !sameLineage(prev, status.lineageId)) return null;
  return { ...prev, status };
}

function sideFilesPrompt(status: SyncStatus | null | undefined): Extract<SyncPrompt, { kind: "side-files" }> | null {
  const p = status?.prompts.find((x) => x.kind === "side-files");
  return p?.kind === "side-files" ? p : null;
}

/**
 * The side-files prompt appeared or changed. Its file tuples come only with `sync_get_state`, and
 * confirming with stale tuples is answered "the files changed" (spec 5.5).
 */
export function sideFilesPromptChanged(prev: SyncStatus | null | undefined, next: SyncStatus): boolean {
  const after = sideFilesPrompt(next);
  if (after === null) return false;
  const before = sideFilesPrompt(prev);
  return before === null || before.walNonEmpty !== after.walNonEmpty || before.upgradeWording !== after.upgradeWording;
}

/** Vault locked: the engine status is gone until the next `sync_get_state`. */
export function withoutStatus(prev: SyncStateResponse | null): SyncStateResponse | null {
  if (prev === null || prev.status === null) return prev;
  return { ...prev, status: null, sideFiles: [], notices: [] };
}

/** Applies a `sync:conflicts-changed` payload to the status count. */
export function withConflictCount(prev: SyncStateResponse | null, ev: ConflictsChangedEvent): SyncStateResponse | null {
  if (prev === null || prev.status === null || prev.status.lineageId !== ev.lineageId) return prev;
  if (prev.status.conflictCount === ev.count) return prev;
  return { ...prev, status: { ...prev.status, conflictCount: ev.count } };
}

/** Adds or replaces a persisted notice (same id). */
export function withNotice(prev: SyncStateResponse | null, notice: LocalNotice): SyncStateResponse | null {
  if (prev === null) return prev;
  const rest = prev.notices.filter((n) => n.id !== notice.id);
  return { ...prev, notices: [...rest, notice] };
}

export function withoutNotice(prev: SyncStateResponse | null, noticeId: string): SyncStateResponse | null {
  if (prev === null || !prev.notices.some((n) => n.id === noticeId)) return prev;
  return { ...prev, notices: prev.notices.filter((n) => n.id !== noticeId) };
}

/** Removes a prompt locally after the user answered it (the next state event confirms). */
export function withoutPrompt(prev: SyncStateResponse | null, promptId: string): SyncStateResponse | null {
  if (prev === null || prev.status === null) return prev;
  const prompts = prev.status.prompts.filter((p) => p.id !== promptId);
  return { ...prev, status: { ...prev.status, prompts } };
}

/** Row keys of every item with a conflict (amber dot in the tree). */
export function conflictRowKeys(groups: readonly ConflictGroup[]): ReadonlySet<string> {
  return new Set(groups.map((g) => rowKeyString(g.row)));
}

/** Groups for one row, for the inline conflict display in the entry views. */
export function groupsForRow(groups: readonly ConflictGroup[], row: SyncRowKey): readonly ConflictGroup[] {
  const key = rowKeyString(row);
  return groups.filter((g) => rowKeyString(g.row) === key);
}

/** Not-snoozed groups first, then snoozed ones; stable otherwise. */
export function orderGroups(groups: readonly ConflictGroup[]): readonly ConflictGroup[] {
  return [...groups.filter((g) => !g.snoozed), ...groups.filter((g) => g.snoozed)];
}

/** The engine's status, or null when no engine runs for the open vault. */
export function activeStatus(state: SyncStateResponse | null): SyncStatus | null {
  if (state === null || state.softLocked) return null;
  return state.status;
}

/** Prompts of the running engine that the user has not put off. */
export function visiblePrompts(state: SyncStateResponse | null, deferred: ReadonlySet<string>): readonly SyncPrompt[] {
  return (activeStatus(state)?.prompts ?? []).filter((p) => !deferred.has(p.id));
}

/** The wait to show: an unlock-time wait wins over a running stale-file wait. */
export function currentWaiting(
  openWaiting: WaitingForDriveState | null,
  state: SyncStateResponse | null,
): WaitingForDriveState | null {
  return openWaiting ?? activeStatus(state)?.waiting ?? null;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** VaultHub: does this recent-vault path have changes that exist only on this device? */
export function isPendingPath(state: SyncStateResponse | null, vaultPath: string): boolean {
  if (state === null) return false;
  const target = normalizePath(vaultPath);
  return state.pendingVaults.some((p) => p.sharedPath !== null && normalizePath(p.sharedPath) === target);
}
