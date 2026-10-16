import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import GatewayTab from "../tabs/GatewayTab";
import { useEntryStore } from "../../../stores/entryStore";
import type { RdpEntryConfig } from "../../../types/entry";

vi.hoisted(() => {
  Object.assign(globalThis, { electron: { invoke: async () => null, on: () => () => undefined } });
});

let latest: Partial<RdpEntryConfig> = {};
const onNewGateway = vi.fn();

function Harness({ initial = {} }: { initial?: Partial<RdpEntryConfig> }) {
  const [config, setConfig] = useState<Partial<RdpEntryConfig>>(initial);
  latest = config;
  return <GatewayTab config={config} onChange={setConfig} onNewGateway={onNewGateway} />;
}

const picker = () => screen.getByRole("combobox", { name: "Gateway" }) as HTMLSelectElement;
const optionTexts = () => [...picker().options].map((o) => o.textContent);

beforeEach(() => {
  latest = {};
  onNewGateway.mockClear();
  useEntryStore.setState({
    entries: [
      { id: "g2", name: "West", entry_type: "credential", credential_type: "rd_gateway", config: { gatewayHostname: "west.example.com", gatewayPort: 8443 } },
      { id: "g1", name: "East", entry_type: "credential", credential_type: "rd_gateway", config: { gatewayHostname: "east.example.com" } },
      { id: "c1", name: "Admin login", entry_type: "credential", credential_type: null, config: {} },
      { id: "r1", name: "app-01", entry_type: "rdp", credential_type: null, config: {} },
    ],
  } as never);
});

describe("GatewayTab", () => {
  it("starts on No gateway and lists only the vault's gateways, by name with their address", () => {
    render(<Harness />);
    expect(picker().value).toBe("");
    expect(optionTexts()).toEqual(["No gateway", "East (east.example.com)", "West (west.example.com:8443)"]);
  });

  it("stores the picked gateway's id and removes it for No gateway", () => {
    render(<Harness />);
    fireEvent.change(picker(), { target: { value: "g2" } });
    expect(latest.gatewayId).toBe("g2");
    fireEvent.change(picker(), { target: { value: "" } });
    expect(latest.gatewayId).toBeUndefined();
  });

  it("warns when the picked gateway was deleted and lets the user pick again", () => {
    render(<Harness initial={{ gatewayId: "gone" }} />);
    expect(screen.getByText(/The gateway this entry used was deleted/)).toBeTruthy();
    expect(picker().value).toBe("gone");
    fireEvent.change(picker(), { target: { value: "g1" } });
    expect(latest.gatewayId).toBe("g1");
    expect(screen.queryByText(/was deleted/)).toBeNull();
  });

  it("offers to create a new gateway", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "New gateway..." }));
    expect(onNewGateway).toHaveBeenCalledTimes(1);
  });

  it("says when the vault has no gateways yet", () => {
    useEntryStore.setState({ entries: [] } as never);
    render(<Harness />);
    expect(screen.getByText(/No gateways in this vault yet/)).toBeTruthy();
  });
});
