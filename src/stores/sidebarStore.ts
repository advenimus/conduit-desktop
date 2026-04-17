import { create } from "zustand";
import { useSessionStore } from "./sessionStore";

interface SidebarState {
  isExpanded: boolean;
  expandedWidth: number;

  expand: () => void;
  collapse: () => void;
  toggle: () => void;
  setExpandedWidth: (width: number) => void;
}

const STORAGE_KEY_WIDTH = "conduit:sidebar-width";

function loadWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (stored) {
      const val = parseInt(stored, 10);
      if (val >= 150 && val <= 500) return val;
    }
  } catch {
    // ignore
  }
  return 250;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  isExpanded: false,
  expandedWidth: loadWidth(),

  expand: () => set({ isExpanded: true }),
  collapse: () => set({ isExpanded: false }),
  toggle: () => set((s) => ({ isExpanded: !s.isExpanded })),

  setExpandedWidth: (width) => {
    const clamped = Math.min(Math.max(width, 150), 500);
    localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    set({ expandedWidth: clamped });
  },
}));

// Auto-close panel when active session changes while panel is open
useSessionStore.subscribe((state, prevState) => {
  const { isExpanded, collapse } = useSidebarStore.getState();
  if (!isExpanded) return;

  if (state.activeSessionId !== prevState.activeSessionId) {
    collapse();
  }
});

// Listen for toggle from keyboard shortcut.
// When expanding, do it directly. When collapsing, dispatch an event so the
// Sidebar component can run its animated collapse (slide-out + unmount).
document.addEventListener("conduit:toggle-sidebar", () => {
  const { isExpanded, expand } = useSidebarStore.getState();
  if (isExpanded) {
    document.dispatchEvent(new CustomEvent("conduit:animated-collapse"));
  } else {
    expand();
  }
});
