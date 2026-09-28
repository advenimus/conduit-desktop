import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
