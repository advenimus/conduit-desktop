import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import SessionRdpTab from "../SessionRdpTab";
import type { Settings } from "../../SettingsHelpers";
import type { RdpGlobalDefaults } from "../../../../types/entry";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

// Saved by a build that had a device-level default gateway.
const WITH_OLD_GATEWAY_KEYS = {
  resolution: "match_window",
  colorDepth: 32,
  sound: "local",
  quality: "good",
  clipboard: true,
  enableNla: true,
  enableHighDpi: true,
  displayScale: 1,
  gatewayEnabled: true,
  gatewayHostname: "gw.example.com",
} as unknown as RdpGlobalDefaults;

describe("SessionRdpTab", () => {
  it("has no default gateway: gateways are vault objects that each RDP entry picks", () => {
    render(<SessionRdpTab settings={{ session_defaults_rdp: WITH_OLD_GATEWAY_KEYS } as Settings} setSettings={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("switch", { name: "Default gateway" })).toBeNull();
    expect(screen.queryByLabelText("Gateway server")).toBeNull();
    expect(screen.queryByText(/gateway/i)).toBeNull();
  });
});
