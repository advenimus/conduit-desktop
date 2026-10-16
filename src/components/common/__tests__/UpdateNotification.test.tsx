import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { UpdateState } from "../../../types/toast";
import UpdateNotificationBridge, { setPushUpdateState } from "../UpdateNotification";

const listeners = new Map<string, (payload: unknown) => void>();
const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const pushed: (UpdateState | null)[] = [];

beforeEach(() => {
  listeners.clear();
  pushed.length = 0;
  invoke.mockResolvedValue(null);
  window.electron = {
    platform: "darwin",
    invoke,
    send: vi.fn(),
    on: vi.fn((channel: string, cb: (payload: unknown) => void) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    }),
    removeListener: vi.fn(),
  };
  setPushUpdateState((state) => pushed.push(state));
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("UpdateNotificationBridge", () => {
  it("hides a downloaded update when the main process clears it", async () => {
    render(<UpdateNotificationBridge />);
    await act(async () => {});
    act(() => listeners.get("update:downloaded")?.({ version: "0.19.0-beta.1" }));
    expect(pushed[pushed.length - 1]).toMatchObject({ state: "downloaded", version: "0.19.0-beta.1" });

    act(() => listeners.get("update:cleared")?.(undefined));
    expect(pushed[pushed.length - 1]).toBeNull();
  });
});
