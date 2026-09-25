import { create } from "zustand";
import { useSessionStore } from "./sessionStore";
import { toast } from "../components/common/Toast";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_DEFAULT_WIDTH = 250;
export const MIN_CONTENT_WIDTH = 480;

const STORAGE_KEY_WIDTH = "conduit:sidebar-width";
const STORAGE_KEY_PINNED = "conduit:sidebar-pinned";
const STORAGE_KEY_PINNED_OPEN = "conduit:sidebar-pinned-open";

interface SidebarLayout {
  isExpanded: boolean;
  isPinned: boolean;
  openWhenDocked: boolean;
  expandedWidth: number;
  viewportWidth: number;
  rightPanelWidth: number;
}

interface SidebarState extends SidebarLayout {
  menuOpen: boolean;
  expand: () => void;
  collapse: () => void;
  toggle: () => void;
  autoCollapse: () => void;
  setPinned: (pinned: boolean) => void;
  togglePin: () => void;
  setExpandedWidth: (width: number) => void;
  saveExpandedWidth: () => void;
  setViewportWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setMenuOpen: (open: boolean) => void;
}

type SpaceInputs = Pick<SidebarLayout, "viewportWidth" | "expandedWidth" | "rightPanelWidth">;

function spareWidth(s: SpaceInputs): number {
  return s.viewportWidth - s.expandedWidth - s.rightPanelWidth - MIN_CONTENT_WIDTH;
}

export function fitsDocked(s: SpaceInputs): boolean {
  return spareWidth(s) >= 0;
}

export function selectIsDocked(s: SidebarLayout): boolean {
  return s.isPinned && fitsDocked(s);
}

export function selectIsDockedOpen(s: SidebarLayout): boolean {
  return s.isExpanded && selectIsDocked(s);
}

export function maxRightPanelWidth(s: SidebarLayout, cap: number): number {
  if (!selectIsDockedOpen(s)) return cap;
  return Math.min(cap, s.rightPanelWidth + spareWidth(s));
}

function clampWidth(width: number, max = SIDEBAR_MAX_WIDTH): number {
  return Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), Math.max(max, SIDEBAR_MIN_WIDTH));
}

// Step aside when room runs out instead of covering the sessions; return when it comes back.
function reconcileSpace(prev: SidebarLayout, next: SidebarLayout): SidebarLayout {
  const docked = selectIsDocked(next);
  if (selectIsDocked(prev) === docked) return next;
  if (!docked) return { ...next, isExpanded: false };
  const isExpanded = next.isExpanded || next.openWhenDocked;
  return { ...next, isExpanded, openWhenDocked: isExpanded };
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the preference just won't survive a restart.
  }
}

function loadWidth(): number {
  const val = parseInt(readStorage(STORAGE_KEY_WIDTH) ?? "", 10);
  return Number.isFinite(val) ? clampWidth(val) : SIDEBAR_DEFAULT_WIDTH;
}

function initialLayout(): SidebarLayout {
  const layout: SidebarLayout = {
    isPinned: readStorage(STORAGE_KEY_PINNED) === "true",
    openWhenDocked: readStorage(STORAGE_KEY_PINNED_OPEN) !== "false",
    isExpanded: false,
    expandedWidth: loadWidth(),
    viewportWidth: window.innerWidth,
    rightPanelWidth: 0,
  };
  return { ...layout, isExpanded: layout.openWhenDocked && selectIsDocked(layout) };
}

export const useSidebarStore = create<SidebarState>((set, get) => {
  // While docked, showing or hiding is a lasting choice. Otherwise it's a temporary peek.
  const setVisible = (isExpanded: boolean) => {
    set(selectIsDocked(get()) ? { isExpanded, openWhenDocked: isExpanded } : { isExpanded });
  };

  const resize = (patch: Partial<SpaceInputs>) => {
    const s = get();
    set(reconcileSpace(s, { ...s, ...patch }));
  };

  return {
    ...initialLayout(),
    menuOpen: false,

    expand: () => setVisible(true),
    collapse: () => setVisible(false),
    toggle: () => setVisible(!get().isExpanded),

    autoCollapse: () => {
      const s = get();
      if (s.isExpanded && !selectIsDocked(s)) set({ isExpanded: false });
    },

    setPinned: (pinned) => {
      if (!pinned) {
        set({ isPinned: false });
        return;
      }
      set({ isPinned: true, isExpanded: true, openWhenDocked: true });
      if (!fitsDocked(get())) {
        toast.info("Sidebar pinned. The window is too narrow to dock it, so it will float until there is more room.");
      }
    },

    togglePin: () => get().setPinned(!get().isPinned),

    setExpandedWidth: (width) => {
      const s = get();
      const max = selectIsDocked(s)
        ? Math.min(SIDEBAR_MAX_WIDTH, s.expandedWidth + spareWidth(s))
        : SIDEBAR_MAX_WIDTH;
      const expandedWidth = clampWidth(width, max);
      if (expandedWidth !== s.expandedWidth) resize({ expandedWidth });
    },

    saveExpandedWidth: () => writeStorage(STORAGE_KEY_WIDTH, String(get().expandedWidth)),

    setViewportWidth: (viewportWidth) => {
      if (get().viewportWidth !== viewportWidth) resize({ viewportWidth });
    },

    setRightPanelWidth: (rightPanelWidth) => {
      if (get().rightPanelWidth !== rightPanelWidth) resize({ rightPanelWidth });
    },

    setMenuOpen: (menuOpen) => set({ menuOpen }),
  };
});

useSidebarStore.subscribe((s, prev) => {
  if (s.isPinned !== prev.isPinned) writeStorage(STORAGE_KEY_PINNED, String(s.isPinned));
  if (s.openWhenDocked !== prev.openWhenDocked) writeStorage(STORAGE_KEY_PINNED_OPEN, String(s.openWhenDocked));
});

useSessionStore.subscribe((state, prevState) => {
  if (state.activeSessionId !== prevState.activeSessionId) {
    useSidebarStore.getState().autoCollapse();
  }
});

window.addEventListener("resize", () => {
  useSidebarStore.getState().setViewportWidth(window.innerWidth);
});

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

document.addEventListener("conduit:toggle-sidebar-pin", () => {
  useSidebarStore.getState().togglePin();
});
