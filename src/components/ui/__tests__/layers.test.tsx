import { describe, it, expect, vi, afterEach } from "vitest";
import { useRef, type ReactNode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useEscapeLayer, useLayer } from "../layers";
import { useEscapeLayer as syncUseEscapeLayer } from "../../sync/useEscapeLayer";

afterEach(cleanup);

function Layer({ name, onEscape, trapFocus = false, children }: { name: string; onEscape?: () => void; trapFocus?: boolean; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayer({ ref, onEscape, trapFocus });
  return (
    <div ref={ref} data-testid={name} tabIndex={-1}>
      {children}
    </div>
  );
}

function EscapeOnly({ onEscape }: { onEscape?: () => void }) {
  useEscapeLayer(onEscape);
  return null;
}

describe("the layer stack", () => {
  it("sends Escape to the top layer only and swallows it", () => {
    const bottom = vi.fn();
    const top = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Layer name="bottom" onEscape={bottom}>
          <button type="button">In bottom</button>
        </Layer>
        <Layer name="top" onEscape={top} />
      </div>,
    );
    fireEvent.keyDown(screen.getByText("In bottom"), { key: "Escape" });
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  it("hands Escape to the layer underneath once the top one unmounts", () => {
    const bottom = vi.fn();
    const top = vi.fn();
    const view = render(
      <>
        <Layer name="bottom" onEscape={bottom} />
        <Layer name="top" onEscape={top} />
      </>,
    );
    view.rerender(<Layer name="bottom" onEscape={bottom} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(bottom).toHaveBeenCalledTimes(1);
    expect(top).not.toHaveBeenCalled();
  });

  it("a top layer without an Escape action still swallows the key", () => {
    const bottom = vi.fn();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(
      <>
        <Layer name="bottom" onEscape={bottom} />
        <EscapeOnly />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(bottom).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("uses the latest Escape handler after a re-render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<EscapeOnly onEscape={first} />);
    view.rerender(<EscapeOnly onEscape={second} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when no layer is open", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const view = render(<EscapeOnly onEscape={vi.fn()} />);
    view.unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", outer);
  });

  it("cycles Tab and Shift+Tab inside a layer that traps focus", () => {
    render(
      <>
        <button type="button">Outside</button>
        <Layer name="dialog" trapFocus>
          <button type="button">First</button>
          <button type="button" tabIndex={-1}>
            Roving
          </button>
          <button type="button" disabled>
            Disabled
          </button>
          <button type="button">Last</button>
        </Layer>
      </>,
    );
    const first = screen.getByText("First");
    const last = screen.getByText("Last");

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    screen.getByText("Outside").focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("does not trap Tab in a layer that does not ask for it", () => {
    render(
      <Layer name="popover">
        <button type="button">Only</button>
      </Layer>,
    );
    const only = screen.getByText("Only");
    only.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    only.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps focus on the panel of a trapping layer with nothing focusable", () => {
    render(<Layer name="empty" trapFocus />);
    const panel = screen.getByTestId("empty");
    panel.focus();
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(document.activeElement).toBe(panel);
  });

  it("src/components/sync/useEscapeLayer.ts re-exports the shared hook", () => {
    expect(syncUseEscapeLayer).toBe(useEscapeLayer);
  });
});
