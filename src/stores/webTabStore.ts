import { create } from "zustand";

export interface WebTabInfo {
  id: string;
  url: string;
  title: string | null;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isSecure: boolean;
}

interface SessionTabState {
  tabs: WebTabInfo[];
  activeTabId: string | null;
}

interface WebTabStore {
  sessionTabs: Record<string, SessionTabState>;

  /** Set the full tab list for a session (e.g., from initial load or tab-list-changed event). */
  setTabs: (sessionId: string, tabs: WebTabInfo[], activeTabId: string | null) => void;

  /** Update a single tab's fields (partial update). */
  updateTab: (sessionId: string, tabId: string, update: Partial<WebTabInfo>) => void;

  /** Add a new tab to a session. */
  addTab: (sessionId: string, tab: WebTabInfo) => void;

  /** Remove a tab from a session. */
  removeTab: (sessionId: string, tabId: string) => void;

  /** Set the active tab for a session. */
  setActiveTab: (sessionId: string, tabId: string) => void;

  /** Clear all tab data for a session (on session close). */
  clearSession: (sessionId: string) => void;
}

export const useWebTabStore = create<WebTabStore>((set) => ({
  sessionTabs: {},

  setTabs: (sessionId, tabs, activeTabId) =>
    set((state) => ({
      sessionTabs: {
        ...state.sessionTabs,
        [sessionId]: { tabs, activeTabId },
      },
    })),

  updateTab: (sessionId, tabId, update) =>
    set((state) => {
      const session = state.sessionTabs[sessionId];
      if (!session) return state;
      return {
        sessionTabs: {
          ...state.sessionTabs,
          [sessionId]: {
            ...session,
            tabs: session.tabs.map((t) =>
              t.id === tabId ? { ...t, ...update } : t
            ),
          },
        },
      };
    }),

  addTab: (sessionId, tab) =>
    set((state) => {
      const session = state.sessionTabs[sessionId] ?? { tabs: [], activeTabId: null };
      return {
        sessionTabs: {
          ...state.sessionTabs,
          [sessionId]: {
            tabs: [...session.tabs, tab],
            activeTabId: tab.id,
          },
        },
      };
    }),

  removeTab: (sessionId, tabId) =>
    set((state) => {
      const session = state.sessionTabs[sessionId];
      if (!session) return state;
      const newTabs = session.tabs.filter((t) => t.id !== tabId);
      let newActiveId = session.activeTabId;
      if (newActiveId === tabId) {
        const oldIndex = session.tabs.findIndex((t) => t.id === tabId);
        const newIndex = Math.min(oldIndex, newTabs.length - 1);
        newActiveId = newTabs[newIndex]?.id ?? null;
      }
      return {
        sessionTabs: {
          ...state.sessionTabs,
          [sessionId]: { tabs: newTabs, activeTabId: newActiveId },
        },
      };
    }),

  setActiveTab: (sessionId, tabId) =>
    set((state) => {
      const session = state.sessionTabs[sessionId];
      if (!session) return state;
      return {
        sessionTabs: {
          ...state.sessionTabs,
          [sessionId]: { ...session, activeTabId: tabId },
        },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.sessionTabs;
      return { sessionTabs: rest };
    }),
}));
