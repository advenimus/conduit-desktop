import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../sessionStore", async () => {
  const { create } = await import("zustand");
  return {
    useSessionStore: create<{ activeSessionId: string | null }>(() => ({
      activeSessionId: null,
    })),
  };
});

const toastInfo = vi.fn();
vi.mock("../../components/common/Toast", () => ({
  toast: { info: (...args: unknown[]) => toastInfo(...args) },
}));

type SidebarModule = typeof import("../sidebarStore");
type Listener = [EventTarget, string, EventListenerOrEventListenerObject];

const moduleListeners: Listener[] = [];

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

// Track listeners the store adds on import so each test only hears its own instance.
async function loadStore(): Promise<SidebarModule> {
  vi.resetModules();
  const docSpy = vi.spyOn(document, "addEventListener");
  const winSpy = vi.spyOn(window, "addEventListener");
  try {
    return await import("../sidebarStore");
  } finally {
    for (const [target, spy] of [[document, docSpy], [window, winSpy]] as const) {
      for (const [type, fn] of spy.mock.calls) moduleListeners.push([target, type, fn]);
      spy.mockRestore();
    }
  }
}

async function loadSessionStore() {
  return (await import("../sessionStore")).useSessionStore;
}

beforeEach(() => {
  localStorage.clear();
  toastInfo.mockClear();
  setWindowWidth(1400);
});

afterEach(() => {
  for (const [target, type, fn] of moduleListeners.splice(0)) {
    target.removeEventListener(type, fn);
  }
});

describe("sidebarStore startup", () => {
  it("starts unpinned and hidden by default", async () => {
    const { useSidebarStore, selectIsDocked } = await loadStore();
    const s = useSidebarStore.getState();
    expect(s.isPinned).toBe(false);
    expect(s.isExpanded).toBe(false);
    expect(s.expandedWidth).toBe(250);
    expect(selectIsDocked(s)).toBe(false);
  });

  it("restores a pinned sidebar as open and docked", async () => {
    localStorage.setItem("conduit:sidebar-pinned", "true");
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
  });

  it("keeps a pinned sidebar hidden if the user hid it last time", async () => {
    localStorage.setItem("conduit:sidebar-pinned", "true");
    localStorage.setItem("conduit:sidebar-pinned-open", "false");
    const { useSidebarStore } = await loadStore();
    expect(useSidebarStore.getState().isExpanded).toBe(false);
  });

  it("starts a pinned sidebar hidden in a narrow window and docks it once there is room", async () => {
    localStorage.setItem("conduit:sidebar-pinned", "true");
    setWindowWidth(600);
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    expect(useSidebarStore.getState().isExpanded).toBe(false);

    useSidebarStore.getState().setViewportWidth(1400);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
  });

  it("clamps a stored width into the allowed range instead of discarding it", async () => {
    localStorage.setItem("conduit:sidebar-width", "160");
    let mod = await loadStore();
    expect(mod.useSidebarStore.getState().expandedWidth).toBe(mod.SIDEBAR_MIN_WIDTH);

    localStorage.setItem("conduit:sidebar-width", "900");
    mod = await loadStore();
    expect(mod.useSidebarStore.getState().expandedWidth).toBe(mod.SIDEBAR_MAX_WIDTH);
  });
});

describe("pinning", () => {
  it("pinning opens the sidebar, docks it, and remembers the choice", async () => {
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
    expect(localStorage.getItem("conduit:sidebar-pinned")).toBe("true");
  });

  it("unpinning leaves the sidebar open as a floating overlay", async () => {
    const { useSidebarStore, selectIsDocked } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().setPinned(false);
    const s = useSidebarStore.getState();
    expect(s.isExpanded).toBe(true);
    expect(selectIsDocked(s)).toBe(false);
    expect(localStorage.getItem("conduit:sidebar-pinned")).toBe("false");
  });

  it("warns and floats when pinned in a window too narrow to dock", async () => {
    setWindowWidth(600);
    const { useSidebarStore, selectIsDocked } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    const s = useSidebarStore.getState();
    expect(s.isPinned).toBe(true);
    expect(s.isExpanded).toBe(true);
    expect(selectIsDocked(s)).toBe(false);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("toggles the pin from the keyboard shortcut event", async () => {
    const { useSidebarStore } = await loadStore();
    document.dispatchEvent(new CustomEvent("conduit:toggle-sidebar-pin"));
    expect(useSidebarStore.getState().isPinned).toBe(true);
    expect(localStorage.getItem("conduit:sidebar-pinned")).toBe("true");
  });

  it("remembers hiding a docked sidebar across restarts", async () => {
    let mod = await loadStore();
    mod.useSidebarStore.getState().setPinned(true);
    mod.useSidebarStore.getState().collapse();
    mod = await loadStore();
    const s = mod.useSidebarStore.getState();
    expect(s.isPinned).toBe(true);
    expect(s.isExpanded).toBe(false);
  });

  it("does not remember closing a pinned sidebar that was only floating", async () => {
    setWindowWidth(600);
    let mod = await loadStore();
    mod.useSidebarStore.getState().setPinned(true);
    mod.useSidebarStore.getState().collapse();

    setWindowWidth(1400);
    mod = await loadStore();
    expect(mod.useSidebarStore.getState().isExpanded).toBe(true);
  });
});

describe("auto-collapse", () => {
  it("closes a floating sidebar", async () => {
    const { useSidebarStore } = await loadStore();
    useSidebarStore.getState().expand();
    useSidebarStore.getState().autoCollapse();
    expect(useSidebarStore.getState().isExpanded).toBe(false);
  });

  it("leaves a docked sidebar open", async () => {
    const { useSidebarStore } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().autoCollapse();
    expect(useSidebarStore.getState().isExpanded).toBe(true);
  });

  it("does not forget the pinned open state when a floating pinned sidebar auto-closes", async () => {
    setWindowWidth(600);
    let mod = await loadStore();
    mod.useSidebarStore.getState().setPinned(true);
    mod.useSidebarStore.getState().autoCollapse();
    expect(mod.useSidebarStore.getState().isExpanded).toBe(false);

    setWindowWidth(1400);
    mod = await loadStore();
    expect(mod.useSidebarStore.getState().isExpanded).toBe(true);
  });

  it("closes a floating sidebar when the active session changes", async () => {
    const { useSidebarStore } = await loadStore();
    const sessions = await loadSessionStore();
    useSidebarStore.getState().expand();
    sessions.setState({ activeSessionId: "s1" });
    expect(useSidebarStore.getState().isExpanded).toBe(false);
  });

  it("keeps a docked sidebar open when the active session changes", async () => {
    const { useSidebarStore } = await loadStore();
    const sessions = await loadSessionStore();
    useSidebarStore.getState().setPinned(true);
    sessions.setState({ activeSessionId: "s2" });
    expect(useSidebarStore.getState().isExpanded).toBe(true);
  });
});

describe("making room for the center content", () => {
  it("hides a docked sidebar when the window shrinks and brings it back when it grows", async () => {
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    useSidebarStore.getState().setPinned(true);

    useSidebarStore.getState().setViewportWidth(600);
    expect(useSidebarStore.getState().isExpanded).toBe(false);

    useSidebarStore.getState().setViewportWidth(1400);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
  });

  it("tracks real window resizes", async () => {
    const { useSidebarStore } = await loadStore();
    setWindowWidth(1111);
    window.dispatchEvent(new Event("resize"));
    expect(useSidebarStore.getState().viewportWidth).toBe(1111);
  });

  it("gives way to a wide right-hand panel and returns when it closes", async () => {
    setWindowWidth(1100);
    const { useSidebarStore } = await loadStore();
    useSidebarStore.getState().setPinned(true);

    useSidebarStore.getState().setRightPanelWidth(500);
    expect(useSidebarStore.getState().isExpanded).toBe(false);

    useSidebarStore.getState().setRightPanelWidth(0);
    expect(useSidebarStore.getState().isExpanded).toBe(true);
  });

  it("comes back after a peek that was closed by opening an entry", async () => {
    setWindowWidth(1100);
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().setRightPanelWidth(400);
    useSidebarStore.getState().expand();
    useSidebarStore.getState().autoCollapse();

    useSidebarStore.getState().setRightPanelWidth(0);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
  });

  it("comes back after a peek that the user closed", async () => {
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().setViewportWidth(600);
    useSidebarStore.getState().expand();
    useSidebarStore.getState().collapse();

    useSidebarStore.getState().setViewportWidth(1400);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
  });

  it("stays hidden after a squeeze if the user hid it while docked", async () => {
    const { useSidebarStore } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().collapse();
    useSidebarStore.getState().setViewportWidth(600);
    useSidebarStore.getState().setViewportWidth(1400);
    expect(useSidebarStore.getState().isExpanded).toBe(false);
  });

  it("keeps a peek open and docked when room comes back while it is showing", async () => {
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().collapse();
    useSidebarStore.getState().setViewportWidth(600);
    useSidebarStore.getState().expand();

    useSidebarStore.getState().setViewportWidth(1400);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
    expect(localStorage.getItem("conduit:sidebar-pinned-open")).toBe("true");
  });

  it("docks a floating pinned sidebar that is dragged narrow enough to fit", async () => {
    setWindowWidth(800);
    const { useSidebarStore, selectIsDockedOpen } = await loadStore();
    useSidebarStore.getState().setExpandedWidth(400);
    useSidebarStore.getState().setPinned(true);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(false);

    useSidebarStore.getState().setExpandedWidth(250);
    expect(selectIsDockedOpen(useSidebarStore.getState())).toBe(true);
  });

  it("stops a docked resize before the center content gets too narrow", async () => {
    setWindowWidth(1000);
    const { useSidebarStore, MIN_CONTENT_WIDTH } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    useSidebarStore.getState().setRightPanelWidth(200);

    useSidebarStore.getState().setExpandedWidth(500);
    expect(useSidebarStore.getState().expandedWidth).toBe(1000 - 200 - MIN_CONTENT_WIDTH);
  });

  it("allows the full width range while floating", async () => {
    setWindowWidth(1000);
    const { useSidebarStore, SIDEBAR_MAX_WIDTH } = await loadStore();
    useSidebarStore.getState().expand();
    useSidebarStore.getState().setExpandedWidth(900);
    expect(useSidebarStore.getState().expandedWidth).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("saves the width only when asked", async () => {
    const { useSidebarStore } = await loadStore();
    useSidebarStore.getState().setExpandedWidth(320);
    expect(localStorage.getItem("conduit:sidebar-width")).toBeNull();

    useSidebarStore.getState().saveExpandedWidth();
    expect(localStorage.getItem("conduit:sidebar-width")).toBe("320");
  });
});

describe("maxRightPanelWidth", () => {
  it("limits a right-hand panel so a docked sidebar and the content both fit", async () => {
    setWindowWidth(1400);
    const { useSidebarStore, maxRightPanelWidth, MIN_CONTENT_WIDTH } = await loadStore();
    useSidebarStore.getState().setPinned(true);
    const s = useSidebarStore.getState();
    expect(maxRightPanelWidth(s, 800)).toBe(1400 - s.expandedWidth - MIN_CONTENT_WIDTH);
  });

  it("does not limit a right-hand panel when the sidebar is floating", async () => {
    const { useSidebarStore, maxRightPanelWidth } = await loadStore();
    expect(maxRightPanelWidth(useSidebarStore.getState(), 800)).toBe(800);
  });
});
