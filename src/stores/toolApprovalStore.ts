import { create } from "zustand";
import { invoke, listen } from "../lib/electron";

export interface PendingToolApproval {
  request_id: string;
  tool_name: string;
  description: string;
  category: string;
  args: Record<string, unknown>;
}

interface ToolApprovalState {
  pendingApprovals: PendingToolApproval[];
  currentApproval: PendingToolApproval | null;

  addPendingApproval: (approval: PendingToolApproval) => void;
  removePendingApproval: (requestId: string) => void;
  setCurrentApproval: (approval: PendingToolApproval | null) => void;

  respondToApproval: (requestId: string, approved: boolean, alwaysAllow: boolean) => Promise<void>;
  dismissAllPending: () => Promise<void>;
  initializeListener: () => Promise<void>;
}

// Module-level guard — prevents double-registration in React StrictMode
let listenerUnlisten: (() => void) | null = null;
let listenerInitializing = false;

export const useToolApprovalStore = create<ToolApprovalState>((set, get) => ({
  pendingApprovals: [],
  currentApproval: null,

  addPendingApproval: (approval) =>
    set((state) => {
      // Dedup guard — ignore if request_id already exists
      if (state.pendingApprovals.some((a) => a.request_id === approval.request_id)) {
        return state;
      }
      return {
        pendingApprovals: [...state.pendingApprovals, approval],
        currentApproval: state.currentApproval ?? approval,
      };
    }),

  removePendingApproval: (requestId) =>
    set((state) => {
      const newPending = state.pendingApprovals.filter(
        (a) => a.request_id !== requestId
      );
      return {
        pendingApprovals: newPending,
        currentApproval:
          state.currentApproval?.request_id === requestId
            ? newPending[0] ?? null
            : state.currentApproval,
      };
    }),

  setCurrentApproval: (approval) => set({ currentApproval: approval }),

  respondToApproval: async (requestId, approved, alwaysAllow) => {
    try {
      await invoke("tool_approval_respond", {
        request_id: requestId,
        approved,
        always_allow: alwaysAllow,
      });
    } catch {
      // Request may already be resolved (timeout or cancel) — ignore
    }
    get().removePendingApproval(requestId);
  },

  /** Deny all pending approvals and clear the queue (e.g., on Stop). */
  dismissAllPending: async () => {
    const pending = get().pendingApprovals;
    // Fire-and-forget deny calls — the main process denyAllPending()
    // handles the authoritative unblock; these just clean up any stragglers.
    for (const approval of pending) {
      invoke("tool_approval_respond", {
        request_id: approval.request_id,
        approved: false,
        always_allow: false,
      }).catch(() => {});
    }
    set({ pendingApprovals: [], currentApproval: null });
  },

  initializeListener: async () => {
    // Idempotent — only register once (survives React StrictMode double-mount)
    if (listenerUnlisten || listenerInitializing) return;
    listenerInitializing = true;

    // Listen for new approval requests
    const unlistenRequest = await listen<PendingToolApproval>(
      "mcp:tool_approval_request",
      (event) => {
        useToolApprovalStore.getState().addPendingApproval(event.payload);
      }
    );

    // Listen for expired approvals (120s timeout on main process side)
    const unlistenExpired = await listen<{ request_id: string }>(
      "mcp:tool_approval_expired",
      (event) => {
        useToolApprovalStore.getState().removePendingApproval(event.payload.request_id);
      }
    );

    listenerUnlisten = () => {
      unlistenRequest();
      unlistenExpired();
    };
    listenerInitializing = false;
  },
}));
