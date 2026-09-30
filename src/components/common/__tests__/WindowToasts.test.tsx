import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import WindowToasts from "../WindowToasts";
import { toast } from "../Toast";

type Listener = (data: unknown) => void;
let listeners: Map<string, Listener>;
type Send = (channel: string, ...args: unknown[]) => void;
let send: ReturnType<typeof vi.fn<Send>>;

beforeEach(() => {
  listeners = new Map();
  send = vi.fn<Send>();
  window.electron = {
    platform: "darwin",
    invoke: vi.fn(async () => null),
    send,
    on: vi.fn((channel: string, cb: Listener) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    }),
    removeListener: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pushes = () => send.mock.calls.filter(([channel]) => channel === "overlay:push-state").map(([, state]) => state);
const lastPush = () => pushes()[pushes().length - 1];

describe("WindowToasts", () => {
  it("sends the window's toasts to its overlay, with no update card", () => {
    render(<WindowToasts />);
    act(() => {
      toast.success("Password copied");
    });
    expect(lastPush()).toEqual({
      toasts: [expect.objectContaining({ type: "success", title: "Password copied" })],
      update: null,
    });
  });

  it("runs a toast action clicked in the overlay and dismisses the toast", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(<WindowToasts />);
    act(() => {
      toast.error("Copy failed", { actions: [{ label: "Retry", onClick }] });
    });
    const [shown] = (lastPush() as { toasts: Array<{ id: string; actions: Array<{ id: string }> }> }).toasts;
    act(() => listeners.get("overlay:action-clicked")?.({ actionId: shown.actions[0].id }));
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(lastPush()).toEqual({ toasts: [], update: null });
  });

  it("stops sending once unmounted", () => {
    const view = render(<WindowToasts />);
    view.unmount();
    send.mockClear();
    toast.info("Nobody listens");
    expect(pushes()).toEqual([]);
  });
});
