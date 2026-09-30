import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../SettingsHelpers";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/electron", () => ({ invoke }));

interface TabProps {
  settings: Settings;
  setSettings: (settings: Settings) => void;
  onApplyDisplayScale?: (settings: Settings) => void;
}

vi.mock("../SettingsNav", () => ({
  default: ({ onTabChange }: { onTabChange: (tab: string) => void }) => (
    <nav>
      <button onClick={() => onTabChange("appearance")}>nav appearance</button>
      <button onClick={() => onTabChange("sessions/rdp")}>nav rdp</button>
    </nav>
  ),
}));
vi.mock("../tabs/AppearanceTab", () => ({
  default: ({ settings, setSettings }: TabProps) => (
    <button onClick={() => setSettings({ ...settings, icon_pack: "hugeicons", color_scheme: "ember" })}>preview hugeicons</button>
  ),
}));
vi.mock("../tabs/SessionRdpTab", () => ({
  default: ({ settings, onApplyDisplayScale }: TabProps) => (
    <button onClick={() => onApplyDisplayScale?.({ ...settings, session_defaults_rdp: { ...settings.session_defaults_rdp, displayScale: 1.5 } })}>
      apply scale
    </button>
  ),
}));

import SettingsDialog from "../SettingsDialog";

const STORED = {
  theme: "dark",
  color_scheme: "modern",
  icon_pack: "lucide",
  ui_scale: 1,
  session_defaults_rdp: { displayScale: 1 },
} as unknown as Settings;

function savedSettings(): Settings[] {
  return invoke.mock.calls.filter(([channel]) => channel === "settings_save").map(([, args]) => (args as { settings: Settings }).settings);
}

const originalElectron = window.electron;

afterEach(() => {
  window.electron = originalElectron;
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => (channel === "settings_get" ? { ...STORED } : null));
});

describe("SettingsDialog display scale", () => {
  it("saves only the RDP change, never an icon pack or scheme that is still a preview", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} initialTab="appearance" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));

    fireEvent.click(screen.getByText("preview hugeicons"));
    fireEvent.click(screen.getByText("nav rdp"));
    await act(async () => {
      fireEvent.click(screen.getByText("apply scale"));
    });
    await waitFor(() => expect(savedSettings()).toHaveLength(1));

    const [saved] = savedSettings();
    expect(saved.session_defaults_rdp).toEqual({ displayScale: 1.5 });
    expect(saved.icon_pack).toBe("lucide");
    expect(saved.color_scheme).toBe("modern");

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(savedSettings()).toHaveLength(1);
  });

  it("still saves the previewed pack with the dialog's Save, after an applied display scale", async () => {
    render(<SettingsDialog onClose={vi.fn()} initialTab="appearance" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));

    fireEvent.click(screen.getByText("preview hugeicons"));
    fireEvent.click(screen.getByText("nav rdp"));
    await act(async () => {
      fireEvent.click(screen.getByText("apply scale"));
    });
    await waitFor(() => expect(savedSettings()).toHaveLength(1));

    invoke.mockImplementation(async (channel: string) =>
      channel === "settings_get" ? { ...STORED, session_defaults_rdp: { displayScale: 1.5 } } : null,
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });
    await waitFor(() => expect(savedSettings()).toHaveLength(2));
    const final = savedSettings()[1];
    expect(final.icon_pack).toBe("hugeicons");
    expect(final.color_scheme).toBe("ember");
    expect(final.session_defaults_rdp).toEqual({ displayScale: 1.5 });
  });
});

describe("SettingsDialog on the Dialog primitive (spec 3.12, 3.12.1, Appendix B)", () => {
  function themeEvents(): { detail: unknown[]; stop: () => void } {
    const detail: unknown[] = [];
    const listener = (e: Event) => detail.push((e as CustomEvent).detail);
    document.addEventListener("conduit:theme-change", listener);
    return { detail, stop: () => document.removeEventListener("conduit:theme-change", listener) };
  }

  async function openPreviewed() {
    const onClose = vi.fn();
    const send = vi.fn();
    window.electron = { send } as unknown as typeof window.electron;
    render(<SettingsDialog onClose={onClose} initialTab="appearance" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
    fireEvent.click(screen.getByText("preview hugeicons"));
    return { onClose, send };
  }

  it("keeps today's width, marks the panel and names it with the Settings h2 (B1)", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveAttribute("data-cv-settings");
    expect(panel).toHaveAttribute("data-dialog-content");
    expect(panel.style.maxWidth).toBe("768px");
    expect(panel).not.toHaveAttribute("aria-label");
    const title = panel.querySelector("h2");
    expect(title?.textContent).toBe("Settings");
    expect(panel).toHaveAttribute("aria-labelledby", title?.id);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
  });

  it("ends with the footer, Cancel then Save (B3)", async () => {
    render(<SettingsDialog onClose={vi.fn()} />);
    const panel = screen.getByRole("dialog");
    const footer = panel.lastElementChild as HTMLElement;
    expect(footer).toHaveAttribute("data-cv-dialog-footer");
    expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
  });

  it("Escape cancels: reverts the previewed appearance and zoom, closes and saves nothing", async () => {
    const { onClose, send } = await openPreviewed();
    const events = themeEvents();
    fireEvent.keyDown(document.body, { key: "Escape" });
    events.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(events.detail).toEqual([{ theme: "dark", colorScheme: "modern", iconPack: "lucide" }]);
    expect(send).toHaveBeenCalledWith("set-zoom-factor", 1);
    expect(savedSettings()).toHaveLength(0);
  });

  it("the close button cancels the same way", async () => {
    const { onClose } = await openPreviewed();
    const events = themeEvents();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    events.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(events.detail).toEqual([{ theme: "dark", colorScheme: "modern", iconPack: "lucide" }]);
    expect(savedSettings()).toHaveLength(0);
  });

  it("a click on the scrim does not close it", async () => {
    const onClose = vi.fn();
    render(<SettingsDialog onClose={onClose} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
    const scrim = screen.getByRole("dialog").parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a save failure as an inline error and stays open", async () => {
    const onClose = vi.fn();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings_get") return { ...STORED };
      if (channel === "settings_save") throw "Disk is full";
      return null;
    });
    render(<SettingsDialog onClose={onClose} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_get"));
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });
    const error = await screen.findByText("Disk is full");
    expect(error).toHaveAttribute("data-cv-error");
    expect(onClose).not.toHaveBeenCalled();
  });
});
