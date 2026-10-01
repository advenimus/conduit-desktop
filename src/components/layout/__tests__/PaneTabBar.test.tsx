import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, fireEvent, act, waitFor } from "@testing-library/react";
import PaneTabBar from "../PaneTabBar";
import type { PaneEdges } from "../LayoutRenderer";
import { useSessionStore, type Session } from "../../../stores/sessionStore";
import { findLeaf, useLayoutStore } from "../../../stores/layoutStore";
import { useSidebarStore } from "../../../stores/sidebarStore";
import { useEntryStore } from "../../../stores/entryStore";
import { useTierStore } from "../../../stores/tierStore";
import { showContextMenu, type PopupMenuItem } from "../../../utils/contextMenu";
import { HOME_SESSION_ID, folderViewSessionId } from "../../../lib/dashboardSessions";

vi.mock("../../../utils/contextMenu", () => ({ showContextMenu: vi.fn() }));
vi.mock("../../common/Toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PANE = "pane-1";
const menu = vi.mocked(showContextMenu);

const SESSIONS: Session[] = [
  { id: "s-term", type: "local_shell", title: "Terminal", status: "connected" },
  { id: "s-doc", type: "document", title: "Runbook", status: "connecting" },
  { id: "s-web", type: "ssh", title: "web-01", status: "disconnected", error: "connect ECONNREFUSED 127.0.0.1:1", entryId: "e-web" },
  { id: "s-rdp", type: "rdp", title: "DC-01", status: "connected", entryId: "e-rdp", metadata: { reconnecting: true } },
];

type SidebarMode = "docked-open" | "floating-open" | "closed";

function setSidebar(mode: SidebarMode) {
  useSidebarStore.setState({
    isExpanded: mode !== "closed",
    isPinned: mode === "docked-open",
    viewportWidth: 1280,
    expandedWidth: 250,
    rightPanelWidth: 0,
  });
}

interface SetupOptions {
  active?: string;
  sidebar?: SidebarMode;
  rightSlot?: React.ReactNode;
  sessions?: Session[];
  edges?: PaneEdges;
}

function setup({ active = "s-term", sidebar = "closed", rightSlot, sessions = SESSIONS, edges }: SetupOptions = {}) {
  useSessionStore.setState({ sessions, updateSessionTitle: vi.fn(), closeSession: vi.fn(async () => undefined) });
  useLayoutStore.setState({
    root: { type: "leaf", id: PANE, sessionIds: sessions.map((s) => s.id), activeSessionId: active },
    focusedPaneId: PANE,
  });
  useEntryStore.setState({ entries: [] });
  setSidebar(sidebar);
  const view = render(<PaneTabBar paneId={PANE} isFocused rightSlot={rightSlot} edges={edges} />);
  const bar = view.container.querySelector("[data-tabbar]") as HTMLElement;
  const tabs = () => [...bar.querySelectorAll<HTMLElement>("[data-cv-tab]")];
  const tab = (id: string) => bar.querySelector<HTMLElement>(`[data-cv-tab="${id}"]`)!;
  return { ...view, bar, tabs, tab };
}

async function openTabMenu(tab: HTMLElement, choice: string | null = null): Promise<PopupMenuItem[]> {
  menu.mockResolvedValueOnce(choice);
  fireEvent.contextMenu(tab);
  await waitFor(() => expect(menu).toHaveBeenCalled());
  return menu.mock.calls[menu.mock.calls.length - 1][2];
}

beforeEach(() => {
  menu.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe("PaneTabBar title bar role", () => {
  it("a pane along the top is part of the title bar; one lower down is not", () => {
    expect(setup({ edges: { top: true, left: false } }).bar.hasAttribute("data-cv-titlebar")).toBe(true);
  });

  it("a lower pane is not part of the title bar", () => {
    const { bar } = setup({ edges: { top: false, left: true } });
    expect(bar.hasAttribute("data-cv-titlebar")).toBe(false);
    expect(bar.hasAttribute("data-cv-window-lead")).toBe(false);
  });

  it("the top-left pane leaves room for the window buttons unless the side bar is docked open", () => {
    expect(setup({ edges: { top: true, left: true } }).bar.hasAttribute("data-cv-window-lead")).toBe(true);
  });

  it("a docked open side bar takes the window buttons instead", () => {
    expect(setup({ edges: { top: true, left: true }, sidebar: "docked-open" }).bar.hasAttribute("data-cv-window-lead")).toBe(false);
  });

  it("a pane with no window edge is neither", () => {
    const { bar } = setup();
    expect(bar.hasAttribute("data-cv-titlebar")).toBe(false);
    expect(bar.hasAttribute("data-cv-window-lead")).toBe(false);
  });
});

describe("PaneTabBar drag state", () => {
  it("clears a tab's dragging mark when the drag ends elsewhere", () => {
    const { tab } = setup();
    fireEvent.dragStart(tab("s-doc"), { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
    expect(tab("s-doc").hasAttribute("data-dragging")).toBe(true);

    act(() => {
      document.dispatchEvent(new CustomEvent("conduit:drag-change", { detail: false }));
    });
    expect(tab("s-doc").hasAttribute("data-dragging")).toBe(false);
  });
});

describe("PaneTabBar strip", () => {
  it("is a cv-tabstrip that keeps data-tabbar", () => {
    const { bar } = setup();
    expect(bar.className).toBe("cv-tabstrip");
  });

  it("puts + and then the right slot in the last cv-tabstrip-slot", () => {
    const { bar } = setup({ rightSlot: <button type="button" title="Toggle AI Panel">AI</button> });
    const slots = bar.querySelectorAll(".cv-tabstrip-slot");
    const last = slots[slots.length - 1];
    const plus = last.querySelector("[data-cv-new-tab]") as HTMLElement;
    expect(plus.getAttribute("title")).toBe("New Local Shell");
    expect([...last.children].map((el) => el.getAttribute("title"))).toEqual(["New Local Shell", "Toggle AI Panel"]);
    expect(bar.lastElementChild).toBe(last);
  });

  it("maps a vertical wheel to horizontal scrolling of the tabs row", () => {
    const { bar } = setup();
    const row = bar.querySelector(".cv-tabs") as HTMLElement;
    fireEvent.wheel(row, { deltaY: 40, deltaX: 0 });
    expect(row.scrollLeft).toBe(40);
    fireEvent.wheel(row, { deltaY: 2, deltaX: 0, deltaMode: 1 });
    expect(row.scrollLeft).toBe(72);
    fireEvent.wheel(row, { deltaY: 30, deltaX: 10 });
    expect(row.scrollLeft).toBe(72);
  });

  it("scrolls the tab that becomes active into view", () => {
    const { tab } = setup();
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    scroll.mockClear();
    act(() => useLayoutStore.getState().setActiveSessionInPane(PANE, "s-rdp"));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(tab("s-rdp"));
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});

describe("PaneTabBar tabs", () => {
  it("marks only the active tab with data-active", () => {
    const { tabs } = setup({ active: "s-doc" });
    expect(tabs().filter((t) => t.hasAttribute("data-active")).map((t) => t.dataset.cvTab)).toEqual(["s-doc"]);
    expect(tabs().every((t) => t.classList.contains("cv-tab"))).toBe(true);
  });

  it("gives every tab a label, its icon, dot and a visible close button in that order", () => {
    const { tabs } = setup();
    for (const t of tabs()) {
      const title = SESSIONS.find((s) => s.id === t.dataset.cvTab)!.title;
      const kids = [...t.children];
      expect(kids[0].className).toBe("cv-tab-fill");
      expect(kids[2].className).toBe("cv-tab-label");
      expect(kids[2].textContent).toBe(title);
      const close = t.querySelector(".cv-tab-close") as HTMLElement;
      expect(kids[kids.length - 1]).toBe(close);
      expect(close.getAttribute("aria-label")).toBe(`Close ${title}`);
      expect(close.className).not.toMatch(/opacity-0|invisible|hidden|group-hover/);
      expect(close.className).not.toMatch(/text-ink/);
      expect(t.querySelectorAll(".cv-tab-label")).toHaveLength(1);
    }
  });

  it("draws a dot for every status with today's tooltips", () => {
    const { tab } = setup();
    const dot = (id: string) => tab(id).children[3] as HTMLElement;
    expect(dot("s-term").getAttribute("title")).toBe("connected");
    expect(dot("s-term").className).toContain("text-(--c-state-connected)");
    expect(dot("s-doc").getAttribute("title")).toBe("connecting");
    expect(dot("s-doc").className).toContain("text-(--c-state-connecting)");
    expect(dot("s-doc").className).toContain("animate-pulse");
    expect(dot("s-doc").className).toContain("motion-reduce:animate-none");
    expect(dot("s-web").getAttribute("title")).toBe("connect ECONNREFUSED 127.0.0.1:1");
    expect(dot("s-web").className).toContain("text-(--c-state-error)");
    expect(dot("s-rdp").getAttribute("title")).toBe("Reconnecting...");
    for (const id of ["s-term", "s-doc", "s-web", "s-rdp"]) expect(dot(id).querySelector("svg")).not.toBeNull();
  });

  it("draws no dot on Home, folder view and entry info tabs, but keeps their close button", () => {
    const pages: Session[] = [
      { id: HOME_SESSION_ID, type: "dashboard", title: "Home", status: "connected" },
      { id: folderViewSessionId("f1"), type: "dashboard", title: "Production", status: "connected", metadata: { folderId: "f1" } },
      { id: "dashboard::e1", type: "dashboard", title: "web-01", status: "connected", entryId: "e1" },
      SESSIONS[0],
    ];
    const { tab } = setup({ sessions: pages, active: HOME_SESSION_ID });
    for (const s of pages.slice(0, 3)) expect(tab(s.id).querySelector('[title="connected"]')).toBeNull();
    expect(tab(folderViewSessionId("f1")).querySelector(".cv-tab-close")).not.toBeNull();
    expect(tab("dashboard::e1").querySelector(".cv-tab-close")).not.toBeNull();
    expect(tab("s-term").querySelector('[title="connected"]')).not.toBeNull();
  });

  it("closes a tab from its close button without selecting it", () => {
    const { tab } = setup();
    fireEvent.click(tab("s-web").querySelector(".cv-tab-close")!);
    expect(useSessionStore.getState().closeSession).toHaveBeenCalledWith("s-web");
    expect(tab("s-web").hasAttribute("data-active")).toBe(false);
  });

  it("marks the drop position with data-drop-target and adds no width", () => {
    const { tab } = setup();
    const before = tab("s-web").className;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => ""), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(tab("s-term"), { dataTransfer });
    fireEvent.dragOver(tab("s-web"), { dataTransfer });
    expect(tab("s-web").hasAttribute("data-drop-target")).toBe(true);
    expect(tab("s-web").className).toBe(before);
    expect(tab("s-term").hasAttribute("data-dragging")).toBe(true);

    const css = readFileSync(resolve(__dirname, "../../../styles/components/tabs.css"), "utf8");
    const rule = css.slice(css.indexOf(".cv-tab[data-drop-target]::before"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("position: absolute");
  });
});

describe("PaneTabBar hamburger", () => {
  it("is absent while the side bar is docked open", () => {
    const { bar } = setup({ sidebar: "docked-open" });
    expect(bar.querySelector("[data-cv-sidebar-toggle]")).toBeNull();
    expect(bar.querySelectorAll(".cv-tabstrip-slot")).toHaveLength(1);
  });

  it("opens the side bar from the first slot when it is closed", () => {
    const expand = vi.fn();
    useSidebarStore.setState({ expand });
    const { bar } = setup({ sidebar: "closed" });
    const toggle = bar.querySelector("[data-cv-sidebar-toggle]") as HTMLElement;
    expect(bar.querySelector(".cv-tabstrip-slot")!.contains(toggle)).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("title")).toBe("Open sidebar (Ctrl+B)");
    expect(toggle.querySelector("span")!.className).not.toContain("opacity-0");
    fireEvent.click(toggle);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("is a transparent spacer while the side bar floats open", () => {
    const collapse = vi.fn();
    document.addEventListener("conduit:animated-collapse", collapse);
    const { bar } = setup({ sidebar: "floating-open" });
    const toggle = bar.querySelector("[data-cv-sidebar-toggle]") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("title")).toBe("Close sidebar (Ctrl+B)");
    const box = toggle.querySelector("span")!;
    expect(box.className).toContain("opacity-0");
    expect(box.className).not.toContain("hover:");
    fireEvent.click(toggle);
    expect(collapse).toHaveBeenCalledTimes(1);
    document.removeEventListener("conduit:animated-collapse", collapse);
  });
});

describe("PaneTabBar rename", () => {
  it("renames from the tab menu: Enter commits, Escape cancels, blur commits", async () => {
    const { tab } = setup();
    await openTabMenu(tab("s-term"), "rename");
    const input = await waitFor(() => tab("s-term").querySelector("input.cv-tab-rename") as HTMLInputElement);
    expect(document.activeElement).toBe(input);
    expect(tab("s-term").getAttribute("draggable")).toBe("false");
    fireEvent.change(input, { target: { value: "Build" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSessionStore.getState().updateSessionTitle).toHaveBeenCalledWith("s-term", "Build");
    expect(tab("s-term").querySelector("input")).toBeNull();

    await openTabMenu(tab("s-term"), "rename");
    const again = await waitFor(() => tab("s-term").querySelector("input.cv-tab-rename") as HTMLInputElement);
    fireEvent.change(again, { target: { value: "Ignored" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(useSessionStore.getState().updateSessionTitle).toHaveBeenCalledTimes(1);
    expect(tab("s-term").querySelector(".cv-tab-label")!.textContent).toBe("Terminal");

    await openTabMenu(tab("s-term"), "rename");
    const third = await waitFor(() => tab("s-term").querySelector("input.cv-tab-rename") as HTMLInputElement);
    fireEvent.change(third, { target: { value: "Blurred" } });
    fireEvent.blur(third);
    expect(useSessionStore.getState().updateSessionTitle).toHaveBeenLastCalledWith("s-term", "Blurred");
  });
});

describe("PaneTabBar menus", () => {
  it("passes semantic icons in the tab menu, with its own glyph for each split", async () => {
    const { tab } = setup();
    useEntryStore.setState({ entries: [{ id: "e-rdp", username: "admin", credential_id: null } as never] });
    useSessionStore.setState({ sessions: SESSIONS.map((s) => (s.id === "s-rdp" ? { ...s, metadata: {} } : s)) });
    const items = await openTabMenu(tab("s-rdp"));
    const icons = Object.fromEntries(items.filter((i) => !i.type).map((i) => [i.id, i.icon]));
    expect(icons).toEqual({
      rename: "textCursor",
      reconnect: "refresh",
      view_info: "infoCircle",
      send_cad: "keyboard",
      copy_username: "user",
      copy_password: "key",
      split_right: "splitHorizontal",
      split_down: "splitVertical",
      close: "close",
    });
    expect(items.map((i) => i.id)).toEqual([
      "rename", "reconnect", "view_info", "send_cad", "sep1", "copy_username", "copy_password",
      "sep2", "split_right", "split_down", "sep3", "close",
    ]);
  });

  it("keeps the + popup's items with semantic icons, anchored to the right edge of +", async () => {
    useTierStore.setState({ cliAgentsEnabled: false });
    const { bar } = setup();
    menu.mockResolvedValueOnce(null);
    fireEvent.click(bar.querySelector("[data-cv-new-tab]")!);
    await waitFor(() => expect(menu).toHaveBeenCalled());
    const [, , items, opts] = menu.mock.calls[0];
    expect(opts).toEqual({ anchorRight: true });
    expect(items.filter((i) => !i.type).map((i) => [i.id, i.icon])).toEqual([
      ["quick_connect", "link"],
      ["home", "home"],
      ["browse", "folder"],
    ]);
  });
});

const HOME: Session = { id: HOME_SESSION_ID, type: "dashboard", title: "Home", status: "connected" };
const WITH_HOME = [HOME, ...SESSIONS];

describe("PaneTabBar Home tab", () => {
  it("shows the house icon and label with no dot and no close button", () => {
    const { tab } = setup({ sessions: WITH_HOME, active: HOME_SESSION_ID });
    const home = tab(HOME_SESSION_ID);
    expect(home.hasAttribute("data-cv-home-tab")).toBe(true);
    expect(home.getAttribute("data-cv-home-tab")).toBe("");
    expect([...home.children].map((c) => c.className)).toEqual(["cv-tab-fill", "flex", "cv-tab-label"]);
    expect(home.querySelector(".cv-tab-label")!.textContent).toBe("Home");
    expect(home.querySelector("svg")!.getAttribute("class")).toContain("text-link");
    expect(home.querySelector(".cv-tab-close")).toBeNull();
    expect(tab("s-term").hasAttribute("data-cv-home-tab")).toBe(false);
  });

  it("names the shortcut in its tooltip for this platform", () => {
    const { tab } = setup({ sessions: WITH_HOME });
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    expect(tab(HOME_SESSION_ID).getAttribute("title")).toBe(isMac ? "Home (Cmd+Shift+H)" : "Home (Ctrl+Shift+H)");
    expect(tab("s-term").hasAttribute("title")).toBe(false);
  });

  it("is not draggable while other tabs are", () => {
    const { tab } = setup({ sessions: WITH_HOME });
    expect(tab(HOME_SESSION_ID).getAttribute("draggable")).toBe("false");
    expect(tab("s-term").getAttribute("draggable")).toBe("true");
  });

  it("shows no menu on right-click and blocks the browser menu", () => {
    const { tab } = setup({ sessions: WITH_HOME });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    tab(HOME_SESSION_ID).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(menu).not.toHaveBeenCalled();
  });

  it("still selects Home on click", () => {
    const { tab } = setup({ sessions: WITH_HOME });
    fireEvent.click(tab(HOME_SESSION_ID));
    expect(tab(HOME_SESSION_ID).hasAttribute("data-active")).toBe(true);
  });

  it("lands a tab dropped on Home right after it and marks that slot", () => {
    const { tab } = setup({ sessions: WITH_HOME });
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => "s-rdp"), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(tab("s-rdp"), { dataTransfer });
    fireEvent.dragOver(tab(HOME_SESSION_ID), { dataTransfer });
    expect(tab(HOME_SESSION_ID).hasAttribute("data-drop-target")).toBe(false);
    expect(tab("s-term").hasAttribute("data-drop-target")).toBe(true);
    fireEvent.drop(tab(HOME_SESSION_ID), { dataTransfer });
    expect(findLeaf(useLayoutStore.getState().root, PANE)?.sessionIds).toEqual([HOME_SESSION_ID, "s-rdp", "s-term", "s-doc", "s-web"]);
  });
});

describe("PaneTabBar folder view tab", () => {
  it("shows the folder icon in the folder's color", () => {
    useEntryStore.setState({ folders: [{ id: "f1", name: "Production", icon: null, color: "#ff0000" }] as never });
    const folderTab: Session = {
      id: folderViewSessionId("f1"),
      type: "dashboard",
      title: "Production",
      status: "connected",
      metadata: { folderId: "f1" },
    };
    const { tab } = setup({ sessions: [folderTab], active: folderTab.id });
    const icon = tab(folderTab.id).querySelector("svg")!;
    expect(icon.getAttribute("class")).toContain("lucide-folder");
    expect(icon.getAttribute("class")).not.toContain("text-link");
    expect(icon.getAttribute("style")).toContain("color: rgb(255, 0, 0)");
    expect(tab(folderTab.id).querySelector(".cv-tab-close")).not.toBeNull();
  });
});
