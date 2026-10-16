import { describe, expect, it } from "vitest";
import { resolveRdpConfig } from "../resolveConfig";
import { HARDCODED_RDP_DEFAULTS, type RdpEntryConfig } from "../../types/entry";

describe("resolveRdpConfig gateway", () => {
  it("carries the entry's gateway id", () => {
    expect(resolveRdpConfig({ gatewayId: "g1" }, HARDCODED_RDP_DEFAULTS).gatewayId).toBe("g1");
  });

  it("has no gateway id when the entry picks none", () => {
    expect(resolveRdpConfig({}, HARDCODED_RDP_DEFAULTS).gatewayId).toBeUndefined();
    expect(resolveRdpConfig({ gatewayId: " " }, HARDCODED_RDP_DEFAULTS).gatewayId).toBeUndefined();
  });

  it("ignores the old per-entry gateway keys", () => {
    const old = { gatewayMode: "custom", gatewayHostname: "gw.example.com", gatewayCredentialId: "c1" } as Partial<RdpEntryConfig>;
    const resolved = resolveRdpConfig(old, HARDCODED_RDP_DEFAULTS) as unknown as Record<string, unknown>;
    expect(Object.keys(resolved).filter((k) => k.startsWith("gateway"))).toEqual(["gatewayId"]);
    expect(resolved.gatewayId).toBeUndefined();
  });
});
