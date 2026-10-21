import { describe, expect, it } from "vitest";
import type { Session } from "../../stores/sessionStore";
import { canOpenAnotherSession, doubleClickAction, sessionForEntry } from "../entrySessions";

const session = (over: Partial<Session> & Pick<Session, "id">): Session => ({
  type: "ssh",
  title: "web-01",
  status: "connected",
  ...over,
});

describe("sessionForEntry", () => {
  it("finds the entry's own session and skips its info tab and other entries", () => {
    const sessions = [
      session({ id: "dashboard::e1", type: "dashboard", entryId: "e1" }),
      session({ id: "ssh-2", entryId: "e2" }),
      session({ id: "ssh-1", entryId: "e1" }),
    ];
    expect(sessionForEntry(sessions, "e1")?.id).toBe("ssh-1");
    expect(sessionForEntry(sessions, "e3")).toBeUndefined();
  });

  it("prefers a live session over one that dropped", () => {
    const sessions = [
      session({ id: "old", entryId: "e1", status: "disconnected" }),
      session({ id: "live", entryId: "e1", status: "connecting" }),
    ];
    expect(sessionForEntry(sessions, "e1")?.id).toBe("live");
    expect(sessionForEntry([sessions[0]], "e1")?.id).toBe("old");
  });

  it("never matches an agent's session, which has no entry", () => {
    expect(sessionForEntry([session({ id: "mcp-1" })], "e1")).toBeUndefined();
  });
});

describe("doubleClickAction", () => {
  it("connects connection entries and opens documents and commands", () => {
    for (const entry_type of ["ssh", "rdp", "vnc", "web", "document", "command"] as const) {
      expect(doubleClickAction({ entry_type }, { canEdit: true })).toBe("open");
    }
  });

  it("edits credentials and RD Gateways, or shows their info when the vault is view-only", () => {
    expect(doubleClickAction({ entry_type: "credential" }, { canEdit: true })).toBe("edit");
    expect(doubleClickAction({ entry_type: "credential", credential_type: "rd_gateway" }, { canEdit: true })).toBe("edit");
    expect(doubleClickAction({ entry_type: "credential" }, { canEdit: false })).toBe("info");
  });
});

describe("canOpenAnotherSession", () => {
  it("is true only for types that run several sessions side by side", () => {
    expect(canOpenAnotherSession("ssh")).toBe(true);
    expect(canOpenAnotherSession("web")).toBe(true);
    for (const t of ["rdp", "vnc", "document", "command", "credential"] as const) expect(canOpenAnotherSession(t)).toBe(false);
  });
});
