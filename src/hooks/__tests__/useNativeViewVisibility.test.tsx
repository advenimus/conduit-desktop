import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useNativeViewVisibility } from "../useNativeViewVisibility";
import { acquireFreeze, freezeHolders } from "../../lib/native-freeze";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const SCREENSHOT = `data:image/png;base64,${"A".repeat(200)}`;

function callsTo(channel: string) {
  return invoke.mock.calls.filter(([c]) => c === channel);
}

function renderVisibility(initial: { isActive: boolean; webviewReady: boolean }) {
  const syncBounds = vi.fn(() => Promise.resolve());
  const hook = renderHook(
    ({ isActive, webviewReady }) => useNativeViewVisibility({ sessionId: "s1", isActive, webviewReady, syncBounds }),
    { initialProps: initial },
  );
  return { hook, syncBounds };
}

beforeEach(() => {
  invoke.mockImplementation(async (channel) => {
    if (channel === "web_session_capture_and_hide" || channel === "web_session_capture_page") return SCREENSHOT;
    return null;
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  for (const type of ["conduit:overlay-change", "conduit:sidebar-overlay-change", "conduit:drag-change"]) {
    document.dispatchEvent(new CustomEvent(type, { detail: false }));
  }
  expect(freezeHolders()).toEqual([]);
});

describe("useNativeViewVisibility", () => {
  it("shows the native view when active, ready and not frozen", async () => {
    const { hook, syncBounds } = renderVisibility({ isActive: true, webviewReady: true });
    expect(hook.result.current.shouldBeNative).toBe(true);
    await waitFor(() => expect(callsTo("web_session_show")).toHaveLength(1));
    expect(syncBounds).toHaveBeenCalled();
    expect(callsTo("web_session_show")[0][1]).toEqual({ sessionId: "s1" });
  });

  it("captures and hides when frozen, and shows again when thawed", async () => {
    const { hook } = renderVisibility({ isActive: true, webviewReady: true });
    await waitFor(() => expect(callsTo("web_session_show")).toHaveLength(1));

    let release = () => {};
    await act(async () => {
      release = acquireFreeze("dialog", "Take over this vault?");
    });
    expect(hook.result.current.shouldBeNative).toBe(false);
    await waitFor(() => expect(callsTo("web_session_capture_and_hide")).toHaveLength(1));
    expect(callsTo("web_session_capture_and_hide")[0][1]).toEqual({ sessionId: "s1" });
    await waitFor(() => expect(hook.result.current.frozenScreenshot).toBe(SCREENSHOT));

    await act(async () => {
      release();
    });
    expect(hook.result.current.shouldBeNative).toBe(true);
    await waitFor(() => expect(callsTo("web_session_show")).toHaveLength(2));
    await waitFor(() => expect(hook.result.current.frozenScreenshot).toBeNull());
  });

  it("stays frozen while any holder remains", async () => {
    const { hook } = renderVisibility({ isActive: true, webviewReady: true });
    let releaseDialog = () => {};
    let releaseDrag = () => {};
    await act(async () => {
      releaseDialog = acquireFreeze("dialog");
      releaseDrag = acquireFreeze("drag");
    });
    await act(async () => {
      releaseDialog();
    });
    expect(hook.result.current.shouldBeNative).toBe(false);
    await act(async () => {
      releaseDrag();
    });
    expect(hook.result.current.shouldBeNative).toBe(true);
  });

  it.each(["conduit:overlay-change", "conduit:sidebar-overlay-change", "conduit:drag-change"])(
    "still freezes on the legacy %s event",
    async (type) => {
      const { hook } = renderVisibility({ isActive: true, webviewReady: true });
      await act(async () => {
        document.dispatchEvent(new CustomEvent(type, { detail: true }));
      });
      expect(hook.result.current.shouldBeNative).toBe(false);
      await waitFor(() => expect(callsTo("web_session_capture_and_hide")).toHaveLength(1));
      await act(async () => {
        document.dispatchEvent(new CustomEvent(type, { detail: false }));
      });
      expect(hook.result.current.shouldBeNative).toBe(true);
    },
  );

  it("hides at once and captures in the background when the tab is deactivated", async () => {
    const { hook } = renderVisibility({ isActive: true, webviewReady: true });
    await waitFor(() => expect(callsTo("web_session_show")).toHaveLength(1));
    hook.rerender({ isActive: false, webviewReady: true });
    await waitFor(() => expect(callsTo("web_session_hide")).toHaveLength(1));
    await waitFor(() => expect(callsTo("web_session_capture_page")).toHaveLength(1));
    expect(callsTo("web_session_capture_and_hide")).toHaveLength(0);
  });

  it("does nothing until the web view exists", async () => {
    const { hook } = renderVisibility({ isActive: true, webviewReady: false });
    await act(async () => {});
    expect(hook.result.current.shouldBeNative).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
