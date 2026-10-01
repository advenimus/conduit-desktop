import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import SidebarPanel from "../SidebarPanel";
import SidebarWindowControls from "../SidebarWindowControls";

// jsdom has no AnimationEvent, so React listens for the webkit-prefixed name there.
function finishAnimation(el: Element) {
  fireEvent.animationEnd(el);
  act(() => {
    el.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
  });
}

function renderPanel(docked: boolean, overrides: Partial<Parameters<typeof SidebarPanel>[0]> = {}) {
  const props = {
    docked,
    closing: false,
    width: 260,
    resizeActive: false,
    onBackdropClick: vi.fn(),
    onResizeStart: vi.fn(),
    ...overrides,
  };
  const view = render(
    <SidebarPanel {...props}>
      <p>tree</p>
    </SidebarPanel>,
  );
  const panel = () => view.container.querySelector("[data-sidebar-panel]") as HTMLElement;
  const backdrop = () => view.container.querySelector(".fixed.inset-0") as HTMLElement | null;
  return { ...view, props, panel, backdrop };
}

describe("SidebarPanel", () => {
  it("floats over the content with a backdrop and slides in", () => {
    const { panel, backdrop, props } = renderPanel(false);
    expect(panel().className).toContain("fixed");
    expect(panel().className).toContain("animate-sidebar-in");
    expect(panel().className).toContain("shadow-overlay");
    expect(panel().className).toContain("bg-sidebar");
    expect(panel().className).toContain("border-divider");
    expect(panel().hasAttribute("data-docked")).toBe(false);
    expect(backdrop()!.className).toContain("bg-(--c-scrim-sidebar)");

    fireEvent.click(backdrop()!);
    expect(props.onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it("fades the backdrop out while closing", () => {
    const { backdrop } = renderPanel(false, { closing: true });
    expect(backdrop()!.className).toContain("bg-transparent");
    expect(backdrop()!.className).not.toContain("bg-(--c-scrim-sidebar)");
  });

  it("gives the floating panel its own 2px accent line at the top", () => {
    const { panel } = renderPanel(false);
    const line = panel().firstElementChild as HTMLElement;
    expect(line.hasAttribute("data-cv-accent-line")).toBe(true);
    expect(line.className).toContain("h-[2px]");
    expect(line.className).toContain("bg-accent");
  });

  it("docks in the layout with no backdrop, shadow, accent line or slide", () => {
    const { panel, backdrop } = renderPanel(true);
    expect(backdrop()).toBeNull();
    expect(panel().className).not.toContain("fixed");
    expect(panel().className).not.toContain("animate-sidebar-in");
    expect(panel().className).not.toContain("shadow-overlay");
    expect(panel().className).toContain("bg-sidebar");
    expect(panel().hasAttribute("data-docked")).toBe(true);
    expect(panel().style.width).toBe("260px");
    expect(panel().style.boxShadow).toBe("");
    expect(panel().querySelector("[data-cv-accent-line]")).toBeNull();
  });

  it("keeps the same content when switching modes and does not replay the slide", () => {
    const { panel, rerender, props } = renderPanel(true);
    const tree = screen.getByText("tree");

    rerender(
      <SidebarPanel {...props} docked={false}>
        <p>tree</p>
      </SidebarPanel>,
    );
    expect(screen.getByText("tree")).toBe(tree);
    expect(panel().className).toContain("fixed");
    expect(panel().className).not.toContain("animate-sidebar-in");
  });

  it("stops the slide-in once it finishes", () => {
    const { panel } = renderPanel(false);
    finishAnimation(panel());
    expect(panel().className).not.toContain("animate-sidebar-in");
  });

  it("ignores animations that finish inside the panel", () => {
    const { panel } = renderPanel(false);
    finishAnimation(screen.getByText("tree"));
    expect(panel().className).toContain("animate-sidebar-in");
  });

  it("plays the slide-out while closing", () => {
    const { panel } = renderPanel(false, { closing: true });
    expect(panel().className).toContain("animate-sidebar-out");
  });

  it("keeps the resize handle inside a docked panel so it never covers the sessions", () => {
    const docked = renderPanel(true);
    const dockedHandle = docked.container.querySelector(".cursor-col-resize") as HTMLElement;
    expect(dockedHandle.style.right).toBe("0px");
    expect(dockedHandle.className).toContain("w-2");
    docked.unmount();

    const floating = renderPanel(false);
    const floatingHandle = floating.container.querySelector(".cursor-col-resize") as HTMLElement;
    expect(floatingHandle.style.right).toBe("-6px");
    expect(floatingHandle.className).toContain("w-3");
  });

  it("runs both hit areas over the panel's full height and names them for the harness (G7 skips them)", () => {
    for (const docked of [true, false]) {
      const view = renderPanel(docked);
      const handle = view.container.querySelector(".cursor-col-resize") as HTMLElement;
      expect(handle.hasAttribute("data-cv-sidebar-resize")).toBe(true);
      expect(handle.className).toContain("top-0");
      expect(handle.className).toContain("bottom-0");
      expect(handle.style.top).toBe("");
      view.unmount();
    }
  });

  it("shows a 4px accent line on the edge after a 300ms hover, and at once while resizing", () => {
    const idle = renderPanel(true);
    const line = () => idle.container.querySelector(".cursor-col-resize > div") as HTMLElement;
    expect(line().className).toContain("w-1");
    expect(line().className).toContain("bg-transparent");
    expect(line().className).toContain("group-hover:bg-accent");
    expect(line().className).toContain("group-hover:delay-300");
    expect(line().className).toContain("duration-100");
    idle.rerender(
      <SidebarPanel {...idle.props} resizeActive>
        <p>tree</p>
      </SidebarPanel>,
    );
    expect(line().className).toContain("bg-accent");
    expect(line().className).toContain("duration-0");
  });

  it("starts a resize from the edge handle", () => {
    const { container, props } = renderPanel(true);
    fireEvent.mouseDown(container.querySelector(".cursor-col-resize")!);
    expect(props.onResizeStart).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarWindowControls", () => {
  function renderControls(isPinned: boolean, isDocked: boolean) {
    const onClose = vi.fn();
    const onTogglePin = vi.fn();
    render(<SidebarWindowControls isPinned={isPinned} isDocked={isDocked} onClose={onClose} onTogglePin={onTogglePin} />);
    return { onClose, onTogglePin };
  }

  it("offers to pin a floating sidebar", () => {
    const { onTogglePin, onClose } = renderControls(false, false);
    const pin = screen.getByRole("button", { name: "Pin sidebar open" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(pin.title).toBe("Pin sidebar open (Ctrl+Shift+B)");

    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Pin sidebar open", "Close sidebar"]);
    expect(buttons[1].title).toBe("Close sidebar (Ctrl+B)");
    fireEvent.click(buttons[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("has no close button while pinned, docked or not", () => {
    renderControls(true, true);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    cleanup();
    renderControls(true, false);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("offers to unpin a docked sidebar", () => {
    renderControls(true, true);
    const pin = screen.getByRole("button", { name: "Unpin sidebar" });
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(pin.title).toBe("Unpin sidebar so it auto-hides (Ctrl+Shift+B)");
    expect(pin.className).toContain("bg-toolbar-active");
    expect(pin.className).not.toContain("opacity-60");
  });

  it("explains why a pinned sidebar is floating", () => {
    renderControls(true, false);
    const pin = screen.getByRole("button", { name: "Unpin sidebar" });
    expect(pin.title).toBe("Pinned, but the window is too narrow to dock it. Unpin (Ctrl+Shift+B)");
    expect(pin.className).toContain("opacity-60");
  });
});
