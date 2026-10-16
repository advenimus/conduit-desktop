import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import SessionRdpTab from "../SessionRdpTab";
import type { Settings } from "../../SettingsHelpers";
import type { RdpGlobalDefaults } from "../../../../types/entry";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

// Saved before the gateway existed: no gateway keys.
const OLD_RDP = {
  resolution: "match_window",
  colorDepth: 32,
  sound: "local",
  quality: "good",
  clipboard: true,
  enableNla: true,
  enableHighDpi: true,
  displayScale: 1,
} as unknown as RdpGlobalDefaults;

let latest: Settings;

function Harness({ rdp = OLD_RDP }: { rdp?: RdpGlobalDefaults }) {
  const [settings, setSettings] = useState({ session_defaults_rdp: rdp } as Settings);
  latest = settings;
  return <SessionRdpTab settings={settings} setSettings={setSettings} onClose={vi.fn()} />;
}

const toggle = () => screen.getByRole("switch", { name: "Default gateway" });

describe("SessionRdpTab default gateway", () => {
  it("is off for settings saved before the gateway existed", () => {
    render(<Harness />);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("Gateway server")).toBeNull();
  });

  it("turns on and saves the server, port and local bypass under session_defaults_rdp", () => {
    render(<Harness />);
    fireEvent.click(toggle());
    expect(latest.session_defaults_rdp.gatewayEnabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Gateway server"), { target: { value: "gw.example.com" } });
    const port = screen.getByLabelText("Port") as HTMLInputElement;
    expect(port.value).toBe("443");
    fireEvent.change(port, { target: { value: "8443" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /^Skip the gateway for local addresses/ }));
    expect(latest.session_defaults_rdp).toMatchObject({
      gatewayEnabled: true,
      gatewayHostname: "gw.example.com",
      gatewayPort: 8443,
      gatewayBypassLocal: true,
      enableNla: true,
    });
  });

  it("moves a port typed into the server name into the port field", () => {
    render(<Harness rdp={{ ...OLD_RDP, gatewayEnabled: true, gatewayHostname: "", gatewayPort: 443, gatewayTransport: "auto", gatewayBypassLocal: false }} />);
    const host = screen.getByLabelText("Gateway server");
    fireEvent.change(host, { target: { value: "gw.example.com:9443" } });
    fireEvent.blur(host);
    expect(latest.session_defaults_rdp).toMatchObject({ gatewayHostname: "gw.example.com", gatewayPort: 9443 });
  });

  it("keeps the transport under Advanced", () => {
    render(<Harness rdp={{ ...OLD_RDP, gatewayEnabled: true, gatewayHostname: "gw", gatewayPort: 443, gatewayTransport: "auto", gatewayBypassLocal: false }} />);
    expect(screen.queryByRole("combobox", { name: "Transport" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Transport" }), { target: { value: "http" } });
    expect(latest.session_defaults_rdp.gatewayTransport).toBe("http");
  });

  it("asks for a server when the default is on without one", () => {
    render(<Harness rdp={{ ...OLD_RDP, gatewayEnabled: true, gatewayHostname: "", gatewayPort: 443, gatewayTransport: "auto", gatewayBypassLocal: false }} />);
    expect(screen.getByText("Enter a gateway server to use the default gateway.")).toBeTruthy();
  });
});
