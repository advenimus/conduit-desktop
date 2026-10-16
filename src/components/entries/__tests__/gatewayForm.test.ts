import { describe, expect, it } from "vitest";
import type { EntryMeta, RdpEntryConfig } from "../../../types/entry";
import {
  describeGatewayUsage,
  gatewayDeleteMessage,
  gatewayEntryConfigForSave,
  gatewayEntryValidationError,
  gatewayLoginChoiceOf,
  gatewayLoginColumns,
  gatewayOptions,
  gatewayUsageCount,
  rdpGatewayConfigForSave,
  splitGatewayHostInput,
} from "../gatewayForm";

function entry(partial: Partial<EntryMeta>): EntryMeta {
  return { entry_type: "rdp", credential_type: null, config: {}, ...partial } as EntryMeta;
}

describe("gatewayEntryConfigForSave", () => {
  it("keeps only the gateway keys, trimmed, with the login source", () => {
    expect(
      gatewayEntryConfigForSave({ gatewayHostname: " gw.example.com ", gatewayPort: 8443, gatewayTransport: "http", gatewayBypassLocal: true }, "typed"),
    ).toEqual({
      gatewayHostname: "gw.example.com",
      gatewayPort: 8443,
      gatewayTransport: "http",
      gatewayBypassLocal: true,
      gatewayLoginSource: "own",
    });
  });

  it("drops defaults and stray keys", () => {
    const config = { gatewayHostname: "gw", gatewayTransport: "auto", gatewayBypassLocal: false, resolution: "1920x1080" } as never;
    expect(gatewayEntryConfigForSave(config, "saved")).toEqual({ gatewayHostname: "gw", gatewayLoginSource: "own" });
  });

  it("moves a port typed into the server box into the port key", () => {
    expect(gatewayEntryConfigForSave({ gatewayHostname: "https://gw:9443/rdgw" }, "typed")).toEqual({
      gatewayHostname: "gw",
      gatewayPort: 9443,
      gatewayLoginSource: "own",
    });
  });

  it("stores connection for the RDP entry's login", () => {
    expect(gatewayEntryConfigForSave({ gatewayHostname: "gw" }, "connection").gatewayLoginSource).toBe("connection");
  });
});

describe("gatewayLoginChoiceOf", () => {
  it("reads connection from the config", () => {
    expect(gatewayLoginChoiceOf({ gatewayLoginSource: "connection" }, "c1")).toBe("connection");
  });

  it("reads a linked credential as saved", () => {
    expect(gatewayLoginChoiceOf({ gatewayLoginSource: "own" }, "c1")).toBe("saved");
  });

  it("falls back to a typed login", () => {
    expect(gatewayLoginChoiceOf({}, null)).toBe("typed");
  });
});

describe("gatewayLoginColumns", () => {
  const fields = { credentialId: "c1", username: " alice ", password: "pw", domain: " CORP " };

  it("keeps the typed login and clears the link", () => {
    expect(gatewayLoginColumns("typed", fields)).toEqual({ credential_id: null, username: "alice", password: "pw", domain: "CORP" });
  });

  it("keeps the link and clears the typed login", () => {
    expect(gatewayLoginColumns("saved", fields)).toEqual({ credential_id: "c1", username: null, password: null, domain: null });
  });

  it("clears both when the RDP entry's login is used", () => {
    expect(gatewayLoginColumns("connection", fields)).toEqual({ credential_id: null, username: null, password: null, domain: null });
  });
});

describe("gatewayEntryValidationError", () => {
  it("needs a server", () => {
    expect(gatewayEntryValidationError({ gatewayHostname: "  " }, "typed", null)).toBe("Enter a gateway server.");
  });

  it("needs a valid port", () => {
    expect(gatewayEntryValidationError({ gatewayHostname: "gw", gatewayPort: 70000 }, "typed", null)).toBe(
      "The gateway port must be a number from 1 to 65535.",
    );
  });

  it("needs a picked credential for a saved login", () => {
    expect(gatewayEntryValidationError({ gatewayHostname: "gw" }, "saved", null)).toBe(
      "Pick a saved credential for the gateway login, or choose another login option.",
    );
    expect(gatewayEntryValidationError({ gatewayHostname: "gw" }, "saved", "c1")).toBeNull();
  });

  it("accepts a server with a typed login", () => {
    expect(gatewayEntryValidationError({ gatewayHostname: "gw" }, "typed", null)).toBeNull();
  });
});

describe("splitGatewayHostInput", () => {
  it("moves a pasted port into an empty port field", () => {
    expect(splitGatewayHostInput("gw:8443", undefined)).toEqual({ gatewayHostname: "gw", gatewayPort: 8443 });
  });

  it("keeps a port the user already typed", () => {
    expect(splitGatewayHostInput("gw:8443", 443)).toEqual({ gatewayHostname: "gw", gatewayPort: 443 });
  });
});

describe("gateway lists", () => {
  const entries = [
    entry({ id: "g2", name: "West gateway", entry_type: "credential", credential_type: "rd_gateway", config: { gatewayHostname: "west", gatewayPort: 8443 } }),
    entry({ id: "g1", name: "East gateway", entry_type: "credential", credential_type: "rd_gateway", config: { gatewayHostname: "east" } }),
    entry({ id: "c1", name: "Admin", entry_type: "credential", credential_type: null }),
    entry({ id: "r1", name: "app-01", config: { gatewayId: "g1" } }),
    entry({ id: "r2", name: "app-02", config: { gatewayId: "g1" } }),
    entry({ id: "r3", name: "app-03", config: { gatewayId: "g2" } }),
    entry({ id: "s1", name: "ssh", entry_type: "ssh", config: { gatewayId: "g1" } }),
  ];

  it("lists the gateways by name with their address", () => {
    expect(gatewayOptions(entries)).toEqual([
      { id: "g1", name: "East gateway", address: "east" },
      { id: "g2", name: "West gateway", address: "west:8443" },
    ]);
  });

  it("counts the RDP entries that use a gateway", () => {
    expect(gatewayUsageCount(entries, "g1")).toBe(2);
    expect(gatewayUsageCount(entries, "g2")).toBe(1);
    expect(gatewayUsageCount(entries, "nope")).toBe(0);
  });
});

describe("rdpGatewayConfigForSave", () => {
  it("keeps a picked gateway", () => {
    expect(rdpGatewayConfigForSave({ enableNla: true, gatewayId: "g1" })).toEqual({ enableNla: true, gatewayId: "g1" });
  });

  it("removes the key for no gateway", () => {
    expect(rdpGatewayConfigForSave({ enableNla: true, gatewayId: undefined })).toEqual({ enableNla: true });
    expect(rdpGatewayConfigForSave({ enableNla: true, gatewayId: "  " })).toEqual({ enableNla: true });
  });

  it("drops the old per-entry gateway keys", () => {
    const old = { enableNla: true, gatewayMode: "custom", gatewayHostname: "gw", gatewayCredentialId: "c1" } as Partial<RdpEntryConfig>;
    expect(rdpGatewayConfigForSave(old)).toEqual({ enableNla: true });
  });
});

describe("gateway usage text", () => {
  it("says how many RDP entries use a gateway", () => {
    expect(describeGatewayUsage(0)).toBe("No RDP entries use this gateway yet.");
    expect(describeGatewayUsage(1)).toBe("Used by 1 RDP entry.");
    expect(describeGatewayUsage(3)).toBe("Used by 3 RDP entries.");
  });

  it("warns before deleting a gateway that is in use", () => {
    expect(gatewayDeleteMessage("Office", 0)).toBe('Are you sure you want to delete "Office"?');
    expect(gatewayDeleteMessage("Office", 1)).toBe(
      'Delete the gateway "Office"? 1 RDP entry uses it. That entry will not connect until you pick another gateway for it.',
    );
    expect(gatewayDeleteMessage("Office", 2)).toBe(
      'Delete the gateway "Office"? 2 RDP entries use it. They will not connect until you pick another gateway for them.',
    );
  });
});
