import { create } from "zustand";
import { syncApi } from "../lib/sync-api";
import type {
  ConflictGroup,
  ConflictsChangedEvent,
  DisplacedEvent,
  DisplacingEvent,
  OpenErrorPayload,
  ResolveGroupRequest,
  ResolveRequest,
  ResolveResult,
  RestoreResult,
  RollbackPreview,
  SessionConflictEvent,
  SyncNoticeEvent,
  SyncRowKey,
  SyncStateResponse,
  SyncStatus,
  WaitingForDriveState,
} from "../types/sync";
import {
  activeStatus,
  conflictRowKeys,
  sideFilesPromptChanged,
  withConflictCount,
  withNotice,
  withoutNotice,
  withoutPrompt,
  withoutStatus,
  withStatus,
} from "./sync-reducers";

/** The one sync panel or dialog opened by the user (only one at a time). */
export type SyncView =
  | { readonly kind: "review"; readonly row: SyncRowKey | null }
  | { readonly kind: "recently-deleted" }
  | { readonly kind: "other-copies" }
  | { readonly kind: "candidate"; readonly candidateId: string; readonly confirmSideFilesAfter: boolean }
  | { readonly kind: "mass-change"; readonly noticeId: string }
  | {
      readonly kind: "restore-preview";
      readonly preview: RollbackPreview;
      /** Re-runs the same restore with a final mode; holds the password only while the dialog is open. */
      readonly apply: (mode: "rollback" | "new-vault", targetPath: string | null) => Promise<RestoreResult>;
    };

interface SyncStoreState {
  state: SyncStateResponse | null;
  conflicts: readonly ConflictGroup[];
  conflictKeys: ReadonlySet<string>;
  openWaiting: WaitingForDriveState | null;
  /** Displacement step 1 to 4: vault access is blocked while the last changes save (6.6). */
  displacing: DisplacingEvent | null;
  displaced: DisplacedEvent | null;
  sessionConflict: SessionConflictEvent | null;
  openError: OpenErrorPayload | null;
  /** The next unlock runs with takeover: true ([Use here instead] after a displacement). */
  takeoverMode: boolean;
  view: SyncView | null;
  /** Prompts the user put off until the next unlock ([Later]). */
  deferredPrompts: ReadonlySet<string>;
  /** Lineage whose "N changes need review" banner was closed this session. */
  reviewBannerClosedFor: string | null;

  refresh: () => Promise<void>;
  loadConflicts: () => Promise<void>;
  applyStatus: (status: SyncStatus) => void;
  applyConflictsChanged: (ev: ConflictsChangedEvent) => void;
  applyPersistedNotice: (ev: SyncNoticeEvent) => void;
  setOpenWaiting: (waiting: WaitingForDriveState | null) => void;
  setDisplacing: (ev: DisplacingEvent | null) => void;
  setDisplaced: (ev: DisplacedEvent | null) => void;
  setSessionConflict: (ev: SessionConflictEvent | null) => void;
  setOpenError: (payload: OpenErrorPayload | null) => void;
  setTakeoverMode: (on: boolean) => void;
  openView: (view: SyncView) => void;
  closeView: () => void;
  deferPrompt: (promptId: string) => void;
  /** Shows a put-off prompt again (the deferred password prompt's [Enter password]). */
  undeferPrompt: (promptId: string) => void;
  closeReviewBanner: () => void;
  dismissPrompt: (promptId: string) => Promise<void>;
  dismissNotice: (noticeId: string) => Promise<void>;
  resolve: (request: ResolveRequest) => Promise<ResolveResult>;
  resolveGroup: (request: ResolveGroupRequest) => Promise<ResolveResult>;
  snooze: (snoozeKey: string) => Promise<ResolveResult>;
  syncNow: () => Promise<void>;
  /** Vault locked: forget everything tied to the open vault. */
  resetForLock: () => void;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
const EMPTY_PROMPTS: ReadonlySet<string> = new Set();

let refreshInFlight: Promise<void> | null = null;

async function fetchState(): Promise<SyncStateResponse | null> {
  try {
    return await syncApi.getState();
  } catch (err) {
    console.error("[sync] Failed to read sync state:", err);
    return null;
  }
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  state: null,
  conflicts: [],
  conflictKeys: EMPTY_KEYS,
  openWaiting: null,
  displacing: null,
  displaced: null,
  sessionConflict: null,
  openError: null,
  takeoverMode: false,
  view: null,
  deferredPrompts: EMPTY_PROMPTS,
  reviewBannerClosedFor: null,

  refresh: () => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const next = await fetchState();
      if (next !== null) set({ state: next });
      await get().loadConflicts();
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  },

  loadConflicts: async () => {
    const status = activeStatus(get().state);
    if (status === null || status.conflictCount === 0) {
      set({ conflicts: [], conflictKeys: EMPTY_KEYS });
      return;
    }
    try {
      const conflicts = await syncApi.listConflicts();
      set({ conflicts, conflictKeys: conflictRowKeys(conflicts) });
    } catch (err) {
      console.error("[sync] Failed to list conflicts:", err);
    }
  },

  applyStatus: (status) => {
    const prev = get().state?.status;
    const next = withStatus(get().state, status);
    if (next === null || sideFilesPromptChanged(prev, status)) {
      if (next !== null) set({ state: next });
      void get().refresh();
      return;
    }
    const countChanged = prev?.conflictCount !== status.conflictCount;
    set({ state: next });
    if (countChanged) void get().loadConflicts();
  },

  applyConflictsChanged: (ev) => {
    set({ state: withConflictCount(get().state, ev) });
    void get().loadConflicts();
  },

  applyPersistedNotice: (ev) => {
    if (!ev.persisted) return;
    set({ state: withNotice(get().state, ev.notice) });
  },

  setOpenWaiting: (waiting) => set({ openWaiting: waiting }),
  setDisplacing: (ev) => set({ displacing: ev }),
  setDisplaced: (ev) => set({ displaced: ev, displacing: null }),
  setSessionConflict: (ev) => set({ sessionConflict: ev }),
  setOpenError: (payload) => set({ openError: payload }),
  setTakeoverMode: (on) => set({ takeoverMode: on }),
  openView: (view) => set({ view }),
  closeView: () => set({ view: null }),

  deferPrompt: (promptId) => set({ deferredPrompts: new Set([...get().deferredPrompts, promptId]) }),
  undeferPrompt: (promptId) => set({ deferredPrompts: new Set([...get().deferredPrompts].filter((id) => id !== promptId)) }),

  closeReviewBanner: () => set({ reviewBannerClosedFor: activeStatus(get().state)?.lineageId ?? null }),

  dismissPrompt: async (promptId) => {
    await syncApi.dismissPrompt(promptId);
    set({ state: withoutPrompt(get().state, promptId) });
  },

  dismissNotice: async (noticeId) => {
    await syncApi.dismissNotice(noticeId);
    set({ state: withoutNotice(get().state, noticeId) });
  },

  resolve: async (request) => {
    const result = await syncApi.resolve(request);
    await get().loadConflicts();
    return result;
  },

  resolveGroup: async (request) => {
    const result = await syncApi.resolveGroup(request);
    await get().loadConflicts();
    return result;
  },

  snooze: async (snoozeKey) => {
    const result = await syncApi.snooze(snoozeKey);
    await get().loadConflicts();
    return result;
  },

  syncNow: async () => {
    await syncApi.syncNow();
    await get().refresh();
  },

  resetForLock: () =>
    set({
      state: withoutStatus(get().state),
      conflicts: [],
      conflictKeys: EMPTY_KEYS,
      openWaiting: null,
      sessionConflict: null,
      displacing: null,
      view: null,
      deferredPrompts: EMPTY_PROMPTS,
      reviewBannerClosedFor: null,
    }),
}));
