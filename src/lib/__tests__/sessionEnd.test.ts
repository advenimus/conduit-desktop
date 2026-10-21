import { describe, expect, it } from "vitest";
import { closesTab } from "../sessionEnd";

describe("closesTab", () => {
  it("closes a tab whose remote side ended the session on purpose", () => {
    expect(closesTab("ssh", { status: "disconnected", error: null, ended: true })).toBe(true);
    expect(closesTab("rdp", { status: "disconnected", error: null, ended: true })).toBe(true);
  });

  it("closes a local shell that exited cleanly, as before", () => {
    expect(closesTab("local_shell", { status: "disconnected", error: null })).toBe(true);
    expect(closesTab("local_shell", { status: "disconnected", error: "Process exited with code 1" })).toBe(false);
  });

  it("keeps the error screen for drops and errors", () => {
    expect(closesTab("ssh", { status: "disconnected", error: null })).toBe(false);
    expect(closesTab("rdp", { status: "disconnected", error: "Connection lost", ended: false })).toBe(false);
    expect(closesTab("ssh", { status: "disconnected", error: "read ECONNRESET", ended: true })).toBe(false);
    expect(closesTab("ssh", { status: "connected", error: null, ended: true })).toBe(false);
  });
});
