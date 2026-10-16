import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import UpdatesSetting from "../tabs/UpdatesSetting";
import type { UpdateChannelInfo } from "../../../lib/updateChannel";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("../../common/Toast", () => ({ toast }));

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 5)));
let channel: UpdateChannelInfo;

beforeEach(() => {
  channel = { betaUpdates: false, version: "0.18.1", isPrerelease: false };
  invoke.mockImplementation(async (name, args) => {
    if (name === "updater_get_channel") return channel;
    if (name === "updater_set_beta_updates") {
      channel = { ...channel, betaUpdates: (args as { enabled: boolean }).enabled };
      return null;
    }
    if (name === "force_check_for_updates") return null;
    return undefined;
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
  Object.values(toast).forEach((fn) => fn.mockReset());
});

const betaSwitch = () => screen.getByRole("switch", { name: "Get beta updates" });

describe("Settings > General > Updates", () => {
  it("shows the version, the beta switch and its help text", async () => {
    render(<UpdatesSetting />);
    await settle();
    expect(screen.getByText("Updates")).toBeInTheDocument();
    expect(screen.getByText("0.18.1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Beta" })).toBeNull();
    expect(betaSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Try new features early. Beta builds use your normal account and data.")).toBeInTheDocument();
    expect(screen.queryByText(/next regular release/)).toBeNull();
  });

  it("turns beta updates on at once through updater_set_beta_updates", async () => {
    render(<UpdatesSetting />);
    await settle();
    fireEvent.click(betaSwitch());
    await settle();
    expect(invoke).toHaveBeenCalledWith("updater_set_beta_updates", { enabled: true });
    expect(betaSwitch()).toHaveAttribute("aria-checked", "true");
    expect(toast.success).toHaveBeenCalledWith("Beta updates are on", "You'll get the next beta when it comes out.");
  });

  it("says when turning beta on found a beta to download", async () => {
    invoke.mockImplementation(async (name) => {
      if (name === "updater_get_channel") return channel;
      if (name === "updater_set_beta_updates") return { version: "0.19.0-beta.1", downloaded: false };
      return undefined;
    });
    render(<UpdatesSetting />);
    await settle();
    fireEvent.click(betaSwitch());
    await settle();
    expect(toast.info).toHaveBeenCalledWith(
      "Conduit 0.19.0-beta.1 is available",
      "It's downloading now. You'll be asked to restart when it's ready.",
    );
  });

  it("on a beta build shows the pill, and turning beta off explains there is no downgrade", async () => {
    channel = { betaUpdates: true, version: "0.19.0-beta.1", isPrerelease: true };
    render(<UpdatesSetting />);
    await settle();
    expect(screen.getByRole("button", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByText(/next regular release/)).toBeNull();
    fireEvent.click(betaSwitch());
    await settle();
    expect(invoke).toHaveBeenCalledWith("updater_set_beta_updates", { enabled: false });
    expect(screen.getByText("You'll move to the next regular release when it comes out.")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Beta updates are off");
  });

  it("keeps the switch as it was when saving fails", async () => {
    invoke.mockImplementation(async (name) => {
      if (name === "updater_get_channel") return channel;
      if (name === "updater_set_beta_updates") throw new Error("Disk full");
      return undefined;
    });
    render(<UpdatesSetting />);
    await settle();
    fireEvent.click(betaSwitch());
    await settle();
    expect(betaSwitch()).toHaveAttribute("aria-checked", "false");
    expect(toast.error).toHaveBeenCalledWith("Couldn't change beta updates", "Disk full");
  });

  it("checks for updates and reports the result in a toast", async () => {
    render(<UpdatesSetting />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await settle();
    expect(invoke).toHaveBeenCalledWith("force_check_for_updates", undefined);
    expect(toast.info).toHaveBeenCalledWith("Conduit is up to date", "You have version 0.18.1.");
  });

  it("reports a failed check", async () => {
    invoke.mockImplementation(async (name) => {
      if (name === "updater_get_channel") return channel;
      if (name === "force_check_for_updates") throw new Error("Offline");
      return undefined;
    });
    render(<UpdatesSetting />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await settle();
    expect(toast.error).toHaveBeenCalledWith("Couldn't check for updates", "Offline");
  });
});
