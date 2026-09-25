import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
    expect(panel().hasAttribute("data-docked")).toBe(false);

    fireEvent.click(backdrop()!);
    expect(props.onBackdropClick).toHaveBeenCalledTimes(1);
  });

  it("docks in the layout with no backdrop, shadow, or slide", () => {
    const { panel, backdrop } = renderPanel(true);
    expect(backdrop()).toBeNull();
    expect(panel().className).not.toContain("fixed");
    expect(panel().className).not.toContain("animate-sidebar-in");
    expect(panel().hasAttribute("data-docked")).toBe(true);
    expect(panel().style.width).toBe("260px");
    expect(panel().style.boxShadow).toBe("");
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
    expect((docked.container.querySelector(".cursor-col-resize") as HTMLElement).style.right).toBe("0px");
    docked.unmount();

    const floating = renderPanel(false);
    expect((floating.container.querySelector(".cursor-col-resize") as HTMLElement).style.right).toBe("-6px");
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
    render(
      <SidebarWindowControls
        isPinned={isPinned}
        isDocked={isDocked}
        onClose={onClose}
        onTogglePin={onTogglePin}
      />,
    );
    return { onClose, onTogglePin };
  }

  it("offers to pin a floating sidebar", () => {
    const { onTogglePin, onClose } = renderControls(false, false);
    const pin = screen.getByRole("button", { name: "Pin sidebar open" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers to unpin or hide a docked sidebar", () => {
    renderControls(true, true);
    const pin = screen.getByRole("button", { name: "Unpin sidebar" });
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(pin.title).toContain("auto-hides");
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
  });

  it("explains why a pinned sidebar is floating", () => {
    renderControls(true, false);
    const pin = screen.getByRole("button", { name: "Unpin sidebar" });
    expect(pin.title).toContain("too narrow");
    expect(pin.className).toContain("opacity-60");
  });
});
