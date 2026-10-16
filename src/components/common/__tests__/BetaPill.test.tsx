import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type BetaPillModule = typeof import("../BetaPill");
let BetaPill: BetaPillModule["default"];
let OPEN_FEEDBACK_EVENT: BetaPillModule["OPEN_FEEDBACK_EVENT"];

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

beforeEach(async () => {
  vi.resetModules();
  ({ default: BetaPill, OPEN_FEEDBACK_EVENT } = await import("../BetaPill"));
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

  it("reads the version once for every pill in the window", async () => {
    invoke.mockResolvedValue("0.19.0-beta.2");
    render(<BetaPill />);
    render(<BetaPill />);
    await act(async () => {});
    render(<BetaPill />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Beta")).toHaveLength(3);
  });

  it("tries again on the next mount after a failed read", async () => {
    invoke.mockRejectedValueOnce(new Error("no")).mockResolvedValue("0.19.0-beta.2");
    render(<BetaPill />);
    await act(async () => {});
    render(<BetaPill />);
    await act(async () => {});
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("stays hidden when the version can't be read", async () => {
    invoke.mockRejectedValue(new Error("no"));
    render(<BetaPill />);
    await act(async () => {});
    expect(screen.queryByText("Beta")).toBeNull();
  });
});
