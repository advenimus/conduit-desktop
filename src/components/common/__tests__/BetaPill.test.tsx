import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import BetaPill, { OPEN_FEEDBACK_EVENT } from "../BetaPill";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

beforeEach(() => {
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("BetaPill", () => {
  it("shows nothing on a regular release", () => {
    render(<BetaPill version="0.18.1" />);
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("shows on a beta build and opens feedback when clicked", () => {
    const opened = vi.fn();
    document.addEventListener(OPEN_FEEDBACK_EVENT, opened);
    render(<BetaPill version="0.19.0-beta.1" />);
    const pill = screen.getByRole("button", { name: /Beta/ });
    expect(pill).toHaveAttribute("title", "You're using a beta build. Click to send feedback.");
    fireEvent.click(pill);
    expect(opened).toHaveBeenCalledTimes(1);
    document.removeEventListener(OPEN_FEEDBACK_EVENT, opened);
  });

  it("reads the running version when none is passed", async () => {
    invoke.mockResolvedValue("0.19.0-beta.2");
    render(<BetaPill />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith("app_get_version", undefined);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("stays hidden when the version can't be read", async () => {
    invoke.mockRejectedValue(new Error("no"));
    render(<BetaPill />);
    await act(async () => {});
    expect(screen.queryByText("Beta")).toBeNull();
  });
});
