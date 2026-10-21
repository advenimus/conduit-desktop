import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SecurityTab from "../tabs/SecurityTab";
import GatewayServerTab from "../tabs/GatewayServerTab";
import { HARDCODED_RDP_DEFAULTS, HARDCODED_WEB_DEFAULTS } from "../../../types/entry";

function renderRdp(rdpConfig = {}) {
  const onRdpConfigChange = vi.fn();
  render(
    <SecurityTab
      entryType="rdp"
      rdpConfig={rdpConfig}
      onRdpConfigChange={onRdpConfigChange}
      webConfig={{}}
      onWebConfigChange={() => {}}
      host="pc1.example.com"
      rdpGlobalDefaults={HARDCODED_RDP_DEFAULTS}
      webGlobalDefaults={HARDCODED_WEB_DEFAULTS}
    />,
  );
  return onRdpConfigChange;
}

describe("SecurityTab certificate and TLS switches", () => {
  it("turns on Skip certificate verification and Allow old TLS", () => {
    const onChange = renderRdp({ enableNla: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /Skip certificate verification/ }));
    expect(onChange).toHaveBeenLastCalledWith({ enableNla: true, skipCertVerification: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /Allow old TLS/ }));
    expect(onChange).toHaveBeenLastCalledWith({ enableNla: true, legacyTls: true });
  });

  it("clears the keys when turned off, so saved config stays flat and small", () => {
    const onChange = renderRdp({ skipCertVerification: true, legacyTls: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /Skip certificate verification/ }));
    expect(onChange).toHaveBeenLastCalledWith({ skipCertVerification: undefined, legacyTls: true });
  });
});

describe("GatewayServerTab old TLS", () => {
  it("shows Advanced open with the switch on, and turns it off", () => {
    const onChange = vi.fn();
    render(<GatewayServerTab config={{ gatewayHostname: "gw", gatewayLegacyTls: true }} onChange={onChange} usageCount={null} showErrors={false} />);
    const box = screen.getByRole("checkbox", { name: /Allow old TLS/ });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ gatewayHostname: "gw", gatewayLegacyTls: undefined });
  });
});
