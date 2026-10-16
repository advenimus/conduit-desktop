import { describe, expect, it } from "vitest";
import { describeDefaultGateway, gatewayConfigForSave, gatewayValidationError, splitGatewayHostInput } from "../gatewayForm";
import { HARDCODED_RDP_DEFAULTS, type RdpEntryConfig } from "../../../types/entry";

const base: Partial<RdpEntryConfig> = { resolution: "1920x1080", enableNla: true };

describe("gatewayConfigForSave", () => {
  it("leaves an entry without gateway keys untouched", () => {
    expect(gatewayConfigForSave(base)).toEqual(base);
  });

  it("keeps only the mode when the gateway is off", () => {
    const saved = gatewayConfigForSave({
      ...base,
      gatewayMode: "off",
      gatewayHostname: "gw",
      gatewayPort: 8443,
      gatewayCredentialMode: "credential",
      gatewayCredentialId: "c1",
    });
    expect(saved).toEqual({ ...base, gatewayMode: "off" });
  });

  it("drops the custom server keys under the default gateway but keeps a picked login", () => {
    const saved = gatewayConfigForSave({
      ...base,
      gatewayMode: undefined,
      gatewayHostname: "gw",
      gatewayTransport: "rpc",
      gatewayBypassLocal: true,
      gatewayCredentialMode: "credential",
      gatewayCredentialId: "c1",
    });
    expect(saved).toEqual({ ...base, gatewayCredentialMode: "credential", gatewayCredentialId: "c1" });
  });

  it("stores a custom gateway with a trimmed host and only the keys that were set", () => {
    const saved = gatewayConfigForSave({ ...base, gatewayMode: "custom", gatewayHostname: "  gw.example.com " });
    expect(saved).toEqual({ ...base, gatewayMode: "custom", gatewayHostname: "gw.example.com" });
  });

  it("keeps the custom port, transport and local bypass", () => {
    const saved = gatewayConfigForSave({
      ...base,
      gatewayMode: "custom",
      gatewayHostname: "gw",
      gatewayPort: 8443,
      gatewayTransport: "http",
      gatewayBypassLocal: true,
    });
    expect(saved).toMatchObject({ gatewayPort: 8443, gatewayTransport: "http", gatewayBypassLocal: true });
  });

  it("drops the credential keys when the gateway uses the same login", () => {
    const saved = gatewayConfigForSave({
      ...base,
      gatewayMode: "custom",
      gatewayHostname: "gw",
      gatewayCredentialMode: "same",
      gatewayCredentialId: "c1",
    });
    expect(saved).not.toHaveProperty("gatewayCredentialMode");
    expect(saved).not.toHaveProperty("gatewayCredentialId");
  });

  it("does not change the object it was given", () => {
    const input: Partial<RdpEntryConfig> = { ...base, gatewayMode: "off", gatewayHostname: "gw" };
    gatewayConfigForSave(input);
    expect(input.gatewayHostname).toBe("gw");
  });
});

describe("gatewayValidationError", () => {
  it("needs a server for a custom gateway", () => {
    expect(gatewayValidationError({ gatewayMode: "custom" })).toMatch(/gateway server/i);
    expect(gatewayValidationError({ gatewayMode: "custom", gatewayHostname: "   " })).toMatch(/gateway server/i);
    expect(gatewayValidationError({ gatewayMode: "custom", gatewayHostname: "gw" })).toBeNull();
  });

  it("needs a picked credential when the gateway uses a saved login", () => {
    expect(gatewayValidationError({ gatewayCredentialMode: "credential" })).toMatch(/saved credential/i);
    expect(gatewayValidationError({ gatewayCredentialMode: "credential", gatewayCredentialId: "c1" })).toBeNull();
  });

  it("ignores the login choice when the gateway is off", () => {
    expect(gatewayValidationError({ gatewayMode: "off", gatewayCredentialMode: "credential" })).toBeNull();
  });

  it("rejects a port out of range", () => {
    expect(gatewayValidationError({ gatewayMode: "custom", gatewayHostname: "gw", gatewayPort: 70000 })).toMatch(/port/i);
  });

  it("accepts an entry with no gateway keys", () => {
    expect(gatewayValidationError({})).toBeNull();
  });
});

describe("splitGatewayHostInput", () => {
  it("moves a typed port into the port field when it is empty", () => {
    expect(splitGatewayHostInput("gw.example.com:8443", undefined)).toEqual({ gatewayHostname: "gw.example.com", gatewayPort: 8443 });
  });

  it("keeps a port that was already set", () => {
    expect(splitGatewayHostInput("gw:8443", 9443)).toEqual({ gatewayHostname: "gw", gatewayPort: 9443 });
  });

  it("strips a pasted URL down to the host", () => {
    expect(splitGatewayHostInput("https://gw.example.com/remoteDesktopGateway/", undefined)).toEqual({
      gatewayHostname: "gw.example.com",
      gatewayPort: undefined,
    });
  });
});

describe("describeDefaultGateway", () => {
  it("names the Settings default with its port", () => {
    expect(
      describeDefaultGateway({ ...HARDCODED_RDP_DEFAULTS, gatewayEnabled: true, gatewayHostname: "gw.example.com" }),
    ).toBe("Default: gw.example.com:443");
  });

  it("uses a port typed into the default's server name", () => {
    expect(
      describeDefaultGateway({ ...HARDCODED_RDP_DEFAULTS, gatewayEnabled: true, gatewayHostname: "gw:8443" }),
    ).toBe("Default: gw:8443");
  });

  it("returns null when no default is on", () => {
    expect(describeDefaultGateway(HARDCODED_RDP_DEFAULTS)).toBeNull();
    expect(describeDefaultGateway({ ...HARDCODED_RDP_DEFAULTS, gatewayEnabled: true, gatewayHostname: "" })).toBeNull();
  });
});
