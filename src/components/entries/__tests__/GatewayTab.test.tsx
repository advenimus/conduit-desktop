import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import GatewayTab from "../tabs/GatewayTab";
import { useVaultStore } from "../../../stores/vaultStore";
import { HARDCODED_RDP_DEFAULTS, type RdpEntryConfig, type RdpGlobalDefaults } from "../../../types/entry";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

let latest: Partial<RdpEntryConfig> = {};

function Harness({ initial = {}, defaults = HARDCODED_RDP_DEFAULTS }: { initial?: Partial<RdpEntryConfig>; defaults?: RdpGlobalDefaults }) {
  const [config, setConfig] = useState<Partial<RdpEntryConfig>>(initial);
  latest = config;
  return <GatewayTab config={config} onChange={setConfig} globalDefaults={defaults} />;
}

const mode = (name: string) => screen.getByRole("radio", { name });

beforeEach(() => {
  latest = {};
  useVaultStore.setState({
    credentials: [
      { id: "c1", name: "Gateway Admin", username: "CORP\\gwadmin", domain: null, tags: [], credential_type: null, created_at: "" },
    ],
  } as never);
});

describe("GatewayTab mode", () => {
  it("starts on the default gateway and says when none is set", () => {
    render(<Harness />);
    expect((mode("Use default gateway") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("No default gateway set")).toBeTruthy();
    expect(screen.getByText(/Settings > Sessions > RDP/)).toBeTruthy();
  });

  it("shows the Settings default it will use", () => {
    render(<Harness defaults={{ ...HARDCODED_RDP_DEFAULTS, gatewayEnabled: true, gatewayHostname: "gw.example.com" }} />);
    expect(screen.getByText("Default: gw.example.com:443")).toBeTruthy();
  });

  it("stores off and hides the server and login fields", () => {
    render(<Harness />);
    fireEvent.click(mode("No gateway"));
    expect(latest.gatewayMode).toBe("off");
    expect(screen.queryByLabelText("Gateway server")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Same login as this computer" })).toBeNull();
  });

  it("shows the custom fields and goes back to default as an unset mode", () => {
    render(<Harness />);
    fireEvent.click(mode("Custom gateway"));
    expect(latest.gatewayMode).toBe("custom");
    expect(screen.getByLabelText("Gateway server")).toBeTruthy();
    expect((screen.getByLabelText("Port") as HTMLInputElement).placeholder).toBe("443");
    expect(screen.getByRole("checkbox", { name: /^Skip the gateway for local addresses/ })).toBeTruthy();
    fireEvent.click(mode("Use default gateway"));
    expect(latest.gatewayMode).toBeUndefined();
  });

  it("keeps the transport under Advanced", () => {
    render(<Harness initial={{ gatewayMode: "custom", gatewayHostname: "gw" }} />);
    expect(screen.queryByRole("combobox", { name: "Transport" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced/ }));
    const transport = screen.getByRole("combobox", { name: "Transport" }) as HTMLSelectElement;
    expect([...transport.options].map((o) => o.textContent)).toEqual(["Automatic", "HTTP", "RPC"]);
    fireEvent.change(transport, { target: { value: "rpc" } });
    expect(latest.gatewayTransport).toBe("rpc");
  });

  it("splits a typed host:port into the port field", () => {
    render(<Harness initial={{ gatewayMode: "custom" }} />);
    const host = screen.getByLabelText("Gateway server");
    fireEvent.change(host, { target: { value: "gw.example.com:8443" } });
    fireEvent.blur(host);
    expect(latest.gatewayHostname).toBe("gw.example.com");
    expect(latest.gatewayPort).toBe(8443);
  });

  it("shows an inline message for a custom gateway with no server", () => {
    render(<Harness initial={{ gatewayMode: "custom" }} />);
    expect(screen.getByText("Enter a gateway server, or choose another gateway option.")).toBeTruthy();
  });
});

describe("GatewayTab login", () => {
  it("defaults to the same login as the computer", () => {
    render(<Harness />);
    expect((screen.getByRole("radio", { name: "Same login as this computer" }) as HTMLInputElement).checked).toBe(true);
  });

  it("picks a saved credential, shows its name, and clears it", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "Use a saved credential" }));
    expect(latest.gatewayCredentialMode).toBe("credential");
    fireEvent.click(screen.getByRole("button", { name: "Choose a credential" }));
    const picker = document.querySelector('[data-cv-layer="sync"]') as HTMLElement;
    fireEvent.click(within(picker).getByText("Gateway Admin"));
    expect(latest.gatewayCredentialId).toBe("c1");
    expect(screen.getByRole("button", { name: "Gateway Admin" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear gateway credential" }));
    expect(latest.gatewayCredentialId).toBeUndefined();
  });

  it("says when the linked credential no longer exists", () => {
    render(<Harness initial={{ gatewayCredentialMode: "credential", gatewayCredentialId: "gone" }} />);
    expect(screen.getByRole("button", { name: "Unknown credential" })).toBeTruthy();
  });

  it("going back to the same login drops the picked credential", () => {
    render(<Harness initial={{ gatewayCredentialMode: "credential", gatewayCredentialId: "c1" }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Same login as this computer" }));
    expect(latest.gatewayCredentialMode).toBeUndefined();
    expect(latest.gatewayCredentialId).toBeUndefined();
  });

  it("keeps the login choice under the default mode, since it applies once a default is set", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "Same login as this computer" })).toBeTruthy();
  });
});
