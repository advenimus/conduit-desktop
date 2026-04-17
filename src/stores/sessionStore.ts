import { create } from "zustand";
import { invoke } from "../lib/electron";
import { disposeTerminalEntry } from "../components/sessions/TerminalView";
import { disposeCommandEntry } from "../components/sessions/CommandView";

export type SessionType = "local_shell" | "ssh" | "rdp" | "vnc" | "web" | "document" | "command" | "dashboard";
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Session {
  id: string;
  type: SessionType;
  title: string;
  status: ConnectionStatus;
  error?: string | null;
  entryId?: string;
  metadata?: Record<string, unknown>;
}

interface SessionState {
  sessions: Session[];
  activeSessionId: string | null;

  // Actions
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  updateSessionTitle: (id: string, title: string) => void;
  updateSessionStatus: (id: string, status: ConnectionStatus, error?: string | null) => void;
  updateSessionMetadata: (id: string, metadata: Record<string, unknown>) => void;
  reorderSession: (fromIndex: number, toIndex: number) => void;
  replaceSessionId: (oldId: string, newId: string, updates?: Partial<Session>) => void;
  /** Clear all sessions from the store (backend already cleaned up). */
  clearAll: () => void;

  // Async actions
  createLocalShell: (shellType?: string, cwd?: string) => Promise<string>;
  closeSession: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  activeSessionId: null,

  addSession: (session) => {
    // Hide native web views immediately before state change so they don't
    // linger on top of the newly-active session during the React render cycle.
    const { activeSessionId: prevId } = get();
    if (prevId !== session.id) {
      invoke("web_session_hide_all").catch(() => {});
    }
    set((state) => {
      // Deduplicate: if session with same ID exists, update it in-place
      const existing = state.sessions.find((s) => s.id === session.id);
      if (existing) {
        return {
          sessions: state.sessions.map((s) =>
            s.id === session.id ? { ...s, ...session } : s
          ),
          activeSessionId: session.id,
        };
      }
      return {
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
      };
    });
  },

  removeSession: (id) =>
    set((state) => {
      const newSessions = state.sessions.filter((s) => s.id !== id);
      const newActiveId =
        state.activeSessionId === id
          ? newSessions.length > 0
            ? newSessions[newSessions.length - 1].id
            : null
          : state.activeSessionId;
      return {
        sessions: newSessions,
        activeSessionId: newActiveId,
      };
    }),

  setActiveSession: (id) => {
    const { activeSessionId: prevId } = get();
    if (prevId !== id) {
      invoke("web_session_hide_all").catch(() => {});
    }
    set({ activeSessionId: id });
  },

  updateSessionTitle: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s
      ),
    })),

  updateSessionStatus: (id, status, error) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, status, error: error ?? null } : s
      ),
    })),

  updateSessionMetadata: (id, metadata) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id
          ? { ...s, metadata: { ...s.metadata, ...metadata } }
          : s
      ),
    })),

  reorderSession: (fromIndex, toIndex) =>
    set((state) => {
      if (fromIndex === toIndex) return state;
      const sessions = [...state.sessions];
      const [moved] = sessions.splice(fromIndex, 1);
      sessions.splice(toIndex, 0, moved);
      return { sessions };
    }),

  replaceSessionId: (oldId, newId, updates) =>
    set((state) => {
      const session = state.sessions.find((s) => s.id === oldId);
      if (!session) return state;
      return {
        sessions: state.sessions.map((s) =>
          s.id === oldId ? { ...s, ...updates, id: newId } : s
        ),
        activeSessionId: state.activeSessionId === oldId ? newId : state.activeSessionId,
      };
    }),

  clearAll: () => set({ sessions: [], activeSessionId: null }),

  createLocalShell: async (shellType?: string, cwd?: string) => {
    try {
      const sessionId = await invoke<string>("local_shell_create", {
        shellType,
        cwd,
      });

      // Derive tab title from last path segment when cwd is provided
      let title = shellType ? `${shellType}` : "Terminal";
      if (cwd) {
        const segment = cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop();
        if (segment) title = `Terminal (${segment})`;
      }

      const session: Session = {
        id: sessionId,
        type: "local_shell",
        title,
        status: "connected",
      };

      get().addSession(session);
      return sessionId;
    } catch (error) {
      console.error("Failed to create local shell:", error);
      throw error;
    }
  },

  closeSession: async (id) => {
    const session = get().sessions.find((s) => s.id === id);
    try {
      if (session?.type === "document" || session?.type === "dashboard") {
        // No IPC cleanup needed
      } else if (session?.type === "command") {
        await invoke("command_cancel", { sessionId: id }).catch(() => {});
        disposeCommandEntry(id);
      } else if (session?.type === "web") {
        await invoke("web_session_close", { sessionId: id });
      } else if (session?.type === "rdp") {
        await invoke("rdp_disconnect", { sessionId: id });
      } else if (session?.type === "vnc") {
        await invoke("vnc_disconnect", { sessionId: id });
      } else {
        await invoke("terminal_close", { sessionId: id });
        disposeTerminalEntry(id);
      }
    } catch (error) {
      console.error("Failed to close session:", error);
    }
    get().removeSession(id);
  },
}));
