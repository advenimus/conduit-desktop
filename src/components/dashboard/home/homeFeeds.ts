import { useEffect } from "react";
import { create } from "zustand";
import { dashboardApi } from "../../../lib/dashboardApi";
import { useVaultStore } from "../../../stores/vaultStore";
import {
  AI_ACTIVITY_POLL_MS,
  HOME_AI_ACTIVITY_LIMIT,
  HOME_RECENT_LIMIT,
  type AiActivityItem,
  type RecentConnection,
} from "../../../types/dashboard";
import { useSessionIdsKey } from "./useDebounced";

const SESSION_CHANGE_DEBOUNCE_MS = 750;

interface HomeFeedsState {
  /** null hides the card: no log, a failed load, or nothing loaded yet. */
  readonly aiActivity: readonly AiActivityItem[] | null;
  readonly recent: readonly RecentConnection[] | null;
  /** Bumped by Clear connection history and by every vault unlock or switch. */
  readonly historyVersion: number;
}

// One copy for every Home view on screen (the Home tab and any empty pane), so they share each load.
const useHomeFeeds = create<HomeFeedsState>(() => ({ aiActivity: null, recent: null, historyVersion: 0 }));

// ---------- AI activity: one poller while a Home view is the active tab of its pane ----------

let aiWatchers = 0;
let aiTimer: ReturnType<typeof setInterval> | null = null;
let aiLoading: Promise<void> | null = null;

function loadAiActivity(): Promise<void> {
  aiLoading ??= dashboardApi
    .aiActivity({ limit: HOME_AI_ACTIVITY_LIMIT })
    .then(
      (res) => useHomeFeeds.setState({ aiActivity: res.logFound ? res.items : null }),
      (err: unknown) => {
        console.warn("[home] ai_activity_recent failed:", err);
        useHomeFeeds.setState({ aiActivity: null });
      },
    )
    .finally(() => {
      aiLoading = null;
    });
  return aiLoading;
}

const loadIfVisible = () => {
  if (document.visibilityState === "visible") void loadAiActivity();
};

/** Loads now, then every AI_ACTIVITY_POLL_MS while the window is visible, until the last watcher leaves. */
export function watchAiActivity(): () => void {
  aiWatchers += 1;
  if (aiWatchers === 1) {
    void loadAiActivity();
    aiTimer = setInterval(loadIfVisible, AI_ACTIVITY_POLL_MS);
    document.addEventListener("visibilitychange", loadIfVisible);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    aiWatchers -= 1;
    if (aiWatchers > 0) return;
    if (aiTimer !== null) clearInterval(aiTimer);
    aiTimer = null;
    document.removeEventListener("visibilitychange", loadIfVisible);
  };
}

export function useAiActivityFeed(active: boolean): readonly AiActivityItem[] | null {
  useEffect(() => (active ? watchAiActivity() : undefined), [active]);
  return useHomeFeeds((s) => s.aiActivity);
}

// ---------- Recently connected: one load per change of the session ids or the history version ----------

let recentKey: string | null = null;

function requestRecent(key: string): void {
  if (key === recentKey) return;
  recentKey = key;
  dashboardApi.historyRecent({ limit: HOME_RECENT_LIMIT }).then(
    (rows) => {
      if (recentKey === key) useHomeFeeds.setState({ recent: rows });
    },
    (err: unknown) => {
      console.warn("[home] connection_history_recent failed:", err);
      if (recentKey !== key) return;
      recentKey = null;
      useHomeFeeds.setState({ recent: null });
    },
  );
}

/** Loads when an active Home view sees new session ids (750 ms debounce) or a new history version. */
export function useRecentConnectionsFeed(active: boolean): readonly RecentConnection[] | null {
  const sessionsKey = useSessionIdsKey(SESSION_CHANGE_DEBOUNCE_MS);
  const version = useHomeFeeds((s) => s.historyVersion);
  useEffect(() => {
    if (active) requestRecent(`${version}\n${sessionsKey}`);
  }, [active, version, sessionsKey]);
  return useHomeFeeds((s) => s.recent);
}

export function bumpHistoryVersion(): void {
  useHomeFeeds.setState((s) => ({ historyVersion: s.historyVersion + 1 }));
}

/** Forgets every feed. For tests. */
export function resetHomeFeeds(): void {
  recentKey = null;
  aiLoading = null;
  useHomeFeeds.setState({ aiActivity: null, recent: null, historyVersion: 0 });
}

// Another vault, or the same one after a lock, has other history: drop the rows, and load again
// once a vault is open (a locked vault answers with no rows).
useVaultStore.subscribe((state, prev) => {
  if (state.isUnlocked === prev.isUnlocked && state.currentVaultPath === prev.currentVaultPath && state.teamVaultId === prev.teamVaultId) return;
  if (!state.isUnlocked) useHomeFeeds.setState({ recent: null });
  else useHomeFeeds.setState((s) => ({ recent: null, historyVersion: s.historyVersion + 1 }));
});
