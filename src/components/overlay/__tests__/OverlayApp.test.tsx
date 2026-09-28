import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import OverlayApp from "../OverlayApp";
import type { OverlayState } from "../../../types/toast";

let push: (state: OverlayState) => void = () => {};
const send = vi.fn();

beforeEach(() => {
  send.mockReset();
  vi.stubGlobal("electron", {
    platform: "darwin",
    invoke: vi.fn(),
    send,
    removeListener: vi.fn(),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      if (event === "overlay:state-updated") push = (state) => act(() => handler(state));
      return () => {};
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FOUR: OverlayState = {
  update: null,
  toasts: [
    { id: "a", type: "success", title: "Username copied" },
    { id: "b", type: "info", title: "Sidebar pinned." },
    { id: "c", type: "warning", title: "Sync paused", actions: [{ id: "c:0", label: "Retry" }] },
    { id: "d", type: "error", title: "No password available" },
  ],
};

describe("OverlayApp", () => {
  it("renders nothing until the main window pushes content", () => {
    const { container } = render(<OverlayApp />);
    expect(container.firstChild).toBeNull();
  });

  it("keeps today's container geometry and stacks the update above the toasts in order", () => {
    const { container } = render(<OverlayApp />);
    push({ ...FOUR, update: { state: "downloading", version: "2.4.0", progress: 3 } });
    const stack = container.firstChild as HTMLElement;
    expect(stack.className).toBe("flex flex-col justify-end items-stretch gap-2 w-full h-screen p-4");
    const ids = [...stack.children].map((c) => c.getAttribute("data-toast"));
    expect(ids).toEqual(["update-notification", "a", "b", "c", "d"]);
  });

  it("sends dismiss, toast action and update action messages", () => {
    render(<OverlayApp />);
    push({ ...FOUR, update: { state: "error", version: "2.4.0" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(send).toHaveBeenCalledWith("overlay:action-clicked", { actionId: "c:0" });
    const dismiss = document.querySelector('[data-toast="d"]')?.querySelector('button[aria-label="Dismiss"]') as HTMLElement;
    fireEvent.click(dismiss);
    expect(send).toHaveBeenCalledWith("overlay:dismiss-toast", { toastId: "d" });
    fireEvent.click(screen.getByRole("button", { name: "Download from Website" }));
    expect(send).toHaveBeenCalledWith("overlay:update-action", { action: "website" });
  });

  it("turns click-through off over a toast and back on outside, through data-toast", () => {
    const { container } = render(<OverlayApp />);
    push(FOUR);
    fireEvent.mouseMove(screen.getByText("Sync paused"));
    expect(send).toHaveBeenLastCalledWith("overlay:set-mouse-ignore", { ignore: false });
    fireEvent.mouseMove(container.firstChild as HTMLElement);
    expect(send).toHaveBeenLastCalledWith("overlay:set-mouse-ignore", { ignore: true, forward: true });
  });
});
