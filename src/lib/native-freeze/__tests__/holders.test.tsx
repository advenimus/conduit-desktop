import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import ConfirmDialog from "../../../components/common/ConfirmDialog";
import { DragProvider, useDragContext } from "../../../components/layout/DragContext";
import { freezeHolders, isFrozen } from "..";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

beforeEach(() => {
  invoke.mockResolvedValue(null);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.useRealTimers();
  expect(freezeHolders()).toEqual([]);
});

describe("ConfirmDialog", () => {
  it("holds a dialog freeze while mounted", () => {
    const view = render(<ConfirmDialog title="Unsaved Changes" message="Discard?" onConfirm={() => {}} onCancel={() => {}} />);
    expect(freezeHolders()).toEqual([expect.objectContaining({ reason: "dialog", label: "Unsaved Changes" })]);
    view.unmount();
    expect(isFrozen()).toBe(false);
  });
});

describe("DragContext", () => {
  let drag: ReturnType<typeof useDragContext>;

  function Probe() {
    drag = useDragContext();
    return null;
  }

  function renderProvider() {
    return render(
      <DragProvider>
        <Probe />
      </DragProvider>,
    );
  }

  it("holds a drag freeze between startDrag and endDrag", () => {
    renderProvider();
    act(() => drag.startDrag("s1", "pane-1"));
    expect(freezeHolders().filter((h) => h.reason === "drag")).toEqual([expect.objectContaining({ label: "s1" })]);
    act(() => drag.endDrag());
    expect(isFrozen()).toBe(false);
  });

  it("keeps web_session_hide_all and the conduit:drag-change event", () => {
    vi.useFakeTimers();
    const changes: unknown[] = [];
    const onChange = (e: Event) => changes.push((e as CustomEvent).detail);
    document.addEventListener("conduit:drag-change", onChange);
    renderProvider();

    act(() => drag.startDrag("s1", "pane-1"));
    expect(invoke).not.toHaveBeenCalledWith("web_session_hide_all", undefined);
    act(() => vi.runAllTimers());
    expect(invoke).toHaveBeenCalledWith("web_session_hide_all", undefined);
    act(() => drag.endDrag());
    expect(changes).toEqual([true, false]);
    document.removeEventListener("conduit:drag-change", onChange);
  });

  it("does not stack freezes when a drag starts twice", () => {
    renderProvider();
    act(() => drag.startDrag("s1", "pane-1"));
    act(() => drag.startDrag("s2", "pane-1"));
    expect(freezeHolders().filter((h) => h.reason === "drag")).toEqual([expect.objectContaining({ label: "s2" })]);
    act(() => drag.endDrag());
    expect(isFrozen()).toBe(false);
  });

  it("releases on a document dragend", () => {
    renderProvider();
    act(() => drag.startDrag("s1", "pane-1"));
    act(() => {
      document.dispatchEvent(new Event("dragend"));
    });
    expect(isFrozen()).toBe(false);
  });

  it("releases when the provider unmounts mid-drag", () => {
    const view = renderProvider();
    act(() => drag.startDrag("s1", "pane-1"));
    view.unmount();
    expect(isFrozen()).toBe(false);
  });
});
