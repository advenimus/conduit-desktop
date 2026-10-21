import { describe, expect, it } from "vitest";
import { KeyIcon, NetworkIcon } from "../../../lib/icons";
import { entryKindOf, getEntryColor, getEntryIcon } from "../entryIcons";
import { entryTypeLabel } from "../entryIcons";
import { countByType } from "../../dashboard/TypeTiles";

const GATEWAY = { entry_type: "credential", credential_type: "rd_gateway" } as const;
const LOGIN = { entry_type: "credential", credential_type: null } as const;

describe("RD Gateway entry kind", () => {
  it("tells a gateway apart from a login credential", () => {
    expect(entryKindOf(GATEWAY)).toBe("rd_gateway");
    expect(entryKindOf(LOGIN)).toBe("credential");
    expect(entryKindOf({ entry_type: "credential", credential_type: "ssh_key" })).toBe("credential");
    expect(entryKindOf({ entry_type: "rdp", credential_type: null })).toBe("rdp");
  });

  it("draws a gateway with the gateway icon and color, a login with the key", () => {
    expect(getEntryIcon("rd_gateway")).toBe(NetworkIcon);
    expect(getEntryColor("rd_gateway").className).toBe("text-entry-rdp");
    expect(getEntryIcon("credential")).toBe(KeyIcon);
  });

  it("names a gateway RD Gateway", () => {
    expect(entryTypeLabel(GATEWAY)).toBe("RD Gateway");
    expect(entryTypeLabel(LOGIN)).toBe("Credential");
    expect(entryTypeLabel({ entry_type: "ssh", credential_type: null })).toBe("SSH");
  });

  it("counts gateways on their own, not as credentials", () => {
    expect(countByType([GATEWAY, LOGIN, LOGIN, { entry_type: "ssh", credential_type: null }])).toEqual({
      rd_gateway: 1,
      credential: 2,
      ssh: 1,
    });
  });
});
