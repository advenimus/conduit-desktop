import { invoke } from "./electron";
import type {
  CandidatePreview,
  CandidateSummary,
  ConfirmSideFilesResult,
  ConflictGroup,
  CopyAction,
  CopyActionResult,
  CopyInfo,
  ForkResultDto,
  PasswordFlowResult,
  RecentlyDeletedItem,
  ResolveGroupRequest,
  ResolveRequest,
  ResolveResult,
  SetEnabledResult,
  SideFileTuple,
  SnapshotSummary,
  SyncDeviceInfo,
  SyncNowResult,
  SyncRegKey,
  SyncRowKey,
  SyncStateResponse,
  UndoApplyResult,
  UndoPreview,
} from "../types/sync";

/** Typed wrappers for the personal-vault sync channels (docs/MULTI_DEVICE_SYNC.md 11.1). */
export const syncApi = {
  getState: () => invoke<SyncStateResponse>("sync_get_state"),
  syncNow: () => invoke<SyncNowResult>("sync_now"),
  listDevices: () => invoke<SyncDeviceInfo[]>("sync_list_devices"),
  listCopies: (rescan: boolean) => invoke<CopyInfo[]>("sync_list_copies", { rescan }),
  copyAction: (path: string, action: CopyAction, targetPath?: string) =>
    invoke<CopyActionResult>("sync_copy_action", { path, action, targetPath }),
  confirmSideFiles: (tuples: readonly SideFileTuple[], walReviewed: boolean) =>
    invoke<ConfirmSideFilesResult>("sync_confirm_side_files", { tuples, walReviewed }),
  reviewSideFileWal: () => invoke<{ candidateId: string }>("sync_review_side_file_wal"),
  locateFile: (path: string) => invoke<boolean>("sync_locate_file", { path }),
  saveNewCopy: (path: string) => invoke<boolean>("sync_save_new_copy", { path }),
  undoRebind: () => invoke<boolean>("sync_undo_rebind"),
  makeSeparateVault: (targetPath: string, promptId?: string) =>
    invoke<ForkResultDto>("sync_make_separate_vault", { targetPath, promptId }),
  exportUnsynced: (lineageId?: string) => invoke<{ path: string }>("sync_export_unsynced", { lineageId }),
  dismissPrompt: (promptId: string) => invoke<void>("sync_dismiss_prompt", { promptId }),
  dismissNotice: (noticeId: string) => invoke<boolean>("sync_dismiss_notice", { noticeId }),
  setEnabled: (enabled: boolean) => invoke<SetEnabledResult>("sync_set_enabled", { enabled }),
  enterNewPassword: (password: string) => invoke<PasswordFlowResult>("sync_enter_new_password", { password }),
  adoptLegacyPassword: (newPassword: string, previousPassword: string | null) =>
    invoke<PasswordFlowResult>("sync_adopt_legacy_password", { newPassword, previousPassword }),
  resolveConcurrentEpoch: (otherPassword: string, winnerEpochId: string) =>
    invoke<PasswordFlowResult>("sync_resolve_concurrent_epoch", { otherPassword, winnerEpochId }),

  sessionTakeover: () => invoke<void>("vault_session_takeover"),
  sessionLockHere: () => invoke<void>("vault_session_lock_here"),
  sessionStopWaiting: (deviceId: string) => invoke<void>("vault_session_stop_waiting", { deviceId }),
  sessionOpenNow: () => invoke<void>("vault_session_open_now"),

  listConflicts: () => invoke<ConflictGroup[]>("sync_list_conflicts"),
  resolve: (request: ResolveRequest) => invoke<ResolveResult>("sync_resolve", { request }),
  resolveGroup: (request: ResolveGroupRequest) => invoke<ResolveResult>("sync_resolve_group", { request }),
  snooze: (snoozeKey: string) => invoke<ResolveResult>("sync_snooze", { snoozeKey }),
  revealSecret: (key: SyncRegKey, versionId: string) =>
    invoke<{ plaintext: string | null }>("sync_reveal_secret", { key, versionId }),
  recoverUndecryptable: (key: SyncRegKey, versionId: string, oldPassword: string) =>
    invoke<{ ok: boolean }>("sync_recover_undecryptable", { key, versionId, oldPassword }),

  listCandidates: () => invoke<CandidateSummary[]>("sync_candidate_list"),
  candidatePreview: (id: string) => invoke<CandidatePreview>("sync_candidate_preview", { id }),
  candidateApply: (id: string, deleteMissing: readonly SyncRowKey[]) =>
    invoke<ResolveResult>("sync_candidate_apply", { id, deleteMissing }),
  candidateDiscard: (id: string) => invoke<void>("sync_candidate_discard", { id }),
  candidateAddFile: (path: string) => invoke<{ candidateId: string }>("sync_candidate_add_file", { path }),
  heldApply: (choice: "apply" | "keep-mine") => invoke<ResolveResult>("sync_held_apply", { choice }),

  listSnapshots: () => invoke<SnapshotSummary[]>("sync_list_snapshots"),
  undoPreview: (snapshotId: string) => invoke<UndoPreview>("sync_undo_preview", { snapshotId }),
  undoApply: (snapshotId: string, rows: readonly SyncRowKey[], fields: readonly SyncRegKey[]) =>
    invoke<UndoApplyResult>("sync_undo_apply", { snapshotId, rows, fields }),
  recentlyDeleted: (showAll: boolean) => invoke<RecentlyDeletedItem[]>("sync_recently_deleted", { showAll }),
  restoreDeleted: (rows: readonly SyncRowKey[]) => invoke<ResolveResult>("sync_restore_deleted", { rows }),
  deletePermanently: (rows: readonly SyncRowKey[] | null, all: boolean) =>
    invoke<void>("sync_delete_permanently", all ? { all: true } : { rows: rows ?? [] }),

  pickVaultFile: (mode: "open" | "save") => invoke<string | null>("vault_pick_file", { mode }),
  openPricing: () => invoke<void>("auth_open_pricing"),
};

/** The plain error text of a failed IPC call. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}
