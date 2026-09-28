import { describe, it, expect, vi } from "vitest";
import { createLayoutNotifier, LAYOUT_CHANGED_EVENT } from "../layout";
import { notifyLayoutChanged } from "..";

describe("createLayoutNotifier", () => {
  it("coalesces calls in one frame into one conduit:layout-changed", () => {
    const frames: FrameRequestCallback[] = [];
    const target = new EventTarget();
    const listener = vi.fn();
    target.addEventListener(LAYOUT_CHANGED_EVENT, listener);
    const notify = createLayoutNotifier(target, (cb) => {
      frames.push(cb);
      return frames.length;
    });

    notify();
    notify();
    notify();
    expect(frames).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();

    frames[0](0);
    expect(listener).toHaveBeenCalledTimes(1);

    notify();
    expect(frames).toHaveLength(2);
    frames[1](16);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("uses the event name the web views listen for", () => {
    expect(LAYOUT_CHANGED_EVENT).toBe("conduit:layout-changed");
  });
});

describe("notifyLayoutChanged", () => {
  it("dispatches on document after the next animation frame", async () => {
    const listener = vi.fn();
    document.addEventListener("conduit:layout-changed", listener);
    notifyLayoutChanged();
    notifyLayoutChanged();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(listener).toHaveBeenCalledTimes(1);
    document.removeEventListener("conduit:layout-changed", listener);
  });
});
