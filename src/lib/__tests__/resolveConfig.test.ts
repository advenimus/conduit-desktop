import { describe, expect, it } from "vitest";
import { resolveGlobalRdp, resolveRdpConfig } from "../resolveConfig";
import { HARDCODED_RDP_DEFAULTS, type RdpGlobalDefaults } from "../../types/entry";

describe("resolveRdpConfig gateway keys", () => {
  it("carries every gateway key from the entry", () => {
    const resolved = resolveRdpConfig(
      {
        gatewayMode: "custom",
        gatewayHostname: "gw.example.com",
        gatewayPort: 8443,
        gatewayTransport: "http",
        gatewayBypassLocal: true,
        gatewayCredentialMode: "credential",
        gatewayCredentialId: "cred-1",
      },
      HARDCODED_RDP_DEFAULTS,
    );
    expect(resolved).toMatchObject({
      gatewayMode: "custom",
      gatewayHostname: "gw.example.com",
      gatewayPort: 8443,
      gatewayTransport: "http",
      gatewayBypassLocal: true,
      gatewayCredentialMode: "credential",
      gatewayCredentialId: "cred-1",
    });
  });

  it("leaves unset gateway keys undefined so the Settings default still applies", () => {
    const resolved = resolveRdpConfig({}, HARDCODED_RDP_DEFAULTS);
    expect(resolved.gatewayMode).toBeUndefined();
    expect(resolved.gatewayHostname).toBeUndefined();
    expect(resolved.gatewayCredentialMode).toBeUndefined();
  });
});

describe("resolveGlobalRdp gateway defaults", () => {
  it("fills the gateway defaults for settings saved before the gateway existed", () => {
    const old = { resolution: "1920x1080", enableNla: false } as Partial<RdpGlobalDefaults>;
    const resolved = resolveGlobalRdp(old);
    expect(resolved.gatewayEnabled).toBe(false);
    expect(resolved.gatewayHostname).toBe("");
    expect(resolved.gatewayPort).toBe(443);
    expect(resolved.gatewayTransport).toBe("auto");
    expect(resolved.gatewayBypassLocal).toBe(false);
    expect(resolved.enableNla).toBe(false);
  });

  it("keeps saved gateway defaults", () => {
    const resolved = resolveGlobalRdp({ gatewayEnabled: true, gatewayHostname: "gw", gatewayPort: 8443 });
    expect(resolved).toMatchObject({ gatewayEnabled: true, gatewayHostname: "gw", gatewayPort: 8443, gatewayTransport: "auto" });
  });
});
