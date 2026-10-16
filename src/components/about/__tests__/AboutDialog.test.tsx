import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import AboutDialog from "../AboutDialog";
import { clickScrim, closeButton, pressEscape, topPanel } from "../../common/__tests__/dialogClose";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

beforeEach(() => {
  invoke.mockImplementation(async (channel) => (channel === "app_get_version" ? "1.2.3" : null));
  vi.stubGlobal("electron", { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  vi.unstubAllGlobals();
});

async function mount() {
  const onClose = vi.fn();
  render(<AboutDialog onClose={onClose} />);
  await act(async () => {});
  return onClose;
}

describe("AboutDialog", () => {
  it("shows the same texts and the website link, and no licenses view (spec 5.9)", async () => {
    await mount();
    const panel = topPanel();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Conduit");
    expect(panel).toHaveTextContent("Version 1.2.3");
    expect(panel).toHaveTextContent("AI-Powered Remote Connection Manager");
    expect(panel).not.toHaveTextContent(/licen[cs]e/i);
    expect(panel).toHaveStyle({ maxWidth: "384px" });
    fireEvent.click(screen.getByRole("button", { name: "conduitdesktop.com" }));
    expect(invoke).toHaveBeenCalledWith("auth_open_website", undefined);
  });

  it("shows no Beta pill on a regular release", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
  });

  it("shows a Beta pill on a beta build", async () => {
    invoke.mockImplementation(async (channel) => (channel === "app_get_version" ? "0.19.0-beta.1" : null));
    await mount();
    expect(topPanel()).toHaveTextContent("Version 0.19.0-beta.1");
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
  });

  it("closes on Escape, a scrim click and its close button (3.12.1)", async () => {
    const onClose = await mount();
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    clickScrim();
    expect(onClose).toHaveBeenCalledTimes(2);
    const close = closeButton();
    expect(close).not.toBeNull();
    fireEvent.click(close as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
