import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import LayoutRenderer from "../LayoutRenderer";
import { DragProvider } from "../DragContext";
import { useSessionStore, type Session } from "../../../stores/sessionStore";
import { useLayoutStore, type LayoutNode } from "../../../stores/layoutStore";
import { useSidebarStore } from "../../../stores/sidebarStore";
import { useEntryStore } from "../../../stores/entryStore";

vi.mock("../../../lib/electron", () => ({
  invoke: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("../../../utils/contextMenu", () => ({ showContextMenu: vi.fn(async () => null) }));

function leaf(id: string, sessionIds: string[] = []): LayoutNode {
  return { type: "leaf", id, sessionIds, activeSessionId: sessionIds[0] ?? null };
}

function split(direction: "horizontal" | "vertical", a: LayoutNode, b: LayoutNode): LayoutNode {
  return { type: "branch", id: "branch-1", direction, sizes: [50, 50], children: [a, b] } as LayoutNode;
}

function setup(root: LayoutNode, sessions: Session[] = [], focused = "pane-a") {
  useSessionStore.setState({ sessions });
  useLayoutStore.setState({ root, focusedPaneId: focused });
  useEntryStore.setState({ entries: [], folders: [], selectedEntryId: null });
  return render(
    <DragProvider>
      <LayoutRenderer node={root} />
    </DragProvider>,
  );
}

const DOC: Session = { id: "s-doc", type: "document", title: "Runbook", status: "connected", entryId: "missing" };

beforeEach(() => {
  useSidebarStore.setState({ isExpanded: false, isPinned: false });
});

describe("split separators", () => {
  it("are 4px wide cv-split-sash bars in the flow between side-by-side panes", () => {
    const { container } = setup(split("horizontal", leaf("pane-a"), leaf("pane-b")));
    const sash = container.querySelector("[role=separator]") as HTMLElement;
    expect(sash.classList.contains("cv-split-sash")).toBe(true);
    expect(sash.classList.contains("w-1")).toBe(true);
    expect(sash.getAttribute("data-orientation")).toBe("vertical");
    expect(sash.className).not.toMatch(/bg-stroke|conduit|absolute|fixed/);
  });

  it("are 4px tall between stacked panes", () => {
    const { container } = setup(split("vertical", leaf("pane-a"), leaf("pane-b")));
    const sash = container.querySelector("[role=separator]") as HTMLElement;
    expect(sash.classList.contains("cv-split-sash")).toBe(true);
    expect(sash.classList.contains("h-1")).toBe(true);
    expect(sash.getAttribute("data-orientation")).toBe("horizontal");
  });
});

describe("panes", () => {
  it("mark every pane's content as a session area and only the focused one as the content area", () => {
    const { container } = setup(split("horizontal", leaf("pane-a"), leaf("pane-b")), [], "pane-b");
    const areas = [...container.querySelectorAll("[data-cv-session-area]")];
    expect(areas).toHaveLength(2);
    expect(container.querySelectorAll("[data-content-area]")).toHaveLength(1);
    expect(areas[1].hasAttribute("data-content-area")).toBe(true);
    expect(container.querySelectorAll("[data-tabbar]")).toHaveLength(2);
  });

  it("show today's text in an empty extra pane on the session surface", () => {
    setup(split("horizontal", leaf("pane-a"), leaf("pane-b")));
    const text = screen.getAllByText("Drag a tab here or open a new session")[0];
    expect(text.className).toBe("text-body");
    expect(text.parentElement!.className).toContain("bg-editor");
    expect(text.parentElement!.className).toContain("text-ink-muted");
  });

  it("show the empty-vault welcome on primitives with today's texts and order", () => {
    setup(leaf("pane-a"));
    const title = screen.getByRole("heading", { name: "Welcome to Conduit" });
    expect(title.className).toContain("text-title");
    const buttons = [...title.parentElement!.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["New Entry", "Quick Connect"]);
    expect(buttons.every((b) => b.hasAttribute("data-cv-text-button"))).toBe(true);
    expect(buttons[0].className).toContain("bg-btn-primary");
    const onNew = vi.fn();
    document.addEventListener("conduit:new-entry", onNew);
    fireEvent.click(buttons[0]);
    expect(onNew).toHaveBeenCalledTimes(1);
    document.removeEventListener("conduit:new-entry", onNew);
  });

  it("show a Spinner with today's text while a session connects", () => {
    const ssh: Session = { id: "s-ssh", type: "ssh", title: "db-01", status: "connecting" };
    const { container } = setup(leaf("pane-a", ["s-ssh"]), [ssh]);
    const text = screen.getByText("Connecting to db-01...");
    const area = container.querySelector("[data-cv-session-area]")!;
    expect(area.querySelector(".animate-spin")).not.toBeNull();
    expect(area.querySelector(".border-b-2")).toBeNull();
    expect(text.parentElement!.className).toContain("bg-editor");
  });
});

describe("drop zones", () => {
  it("overlay the pane at z-40 while a tab drags and draw the zone in the drop colors", () => {
    const { container } = setup(split("horizontal", leaf("pane-a", ["s-doc"]), leaf("pane-b")), [DOC]);
    expect(container.querySelector(".z-40")).toBeNull();
    const tab = container.querySelector('[data-cv-tab="s-doc"]') as HTMLElement;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => "s-doc"), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(tab, { dataTransfer });

    const overlays = [...container.querySelectorAll<HTMLElement>("[data-cv-session-area] > .z-40")];
    expect(overlays).toHaveLength(2);
    for (const overlay of overlays) expect(overlay.className).toBe("absolute inset-0 z-40 overflow-hidden");

    fireEvent.dragOver(overlays[1], { dataTransfer });
    const zone = overlays[1].firstElementChild as HTMLElement;
    expect(zone.className).toContain("bg-(--c-drop-bg)");
    expect(zone.className).toContain("outline-accent");
    expect(zone.className).toContain("pointer-events-none");
    expect(zone.className).not.toMatch(/conduit|border-2/);
  });
});
