import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => null);
vi.mock("./../electron", () => ({ invoke: (...args: unknown[]) => invoke(...(args as [])) }));

const { useSessionStore } = await import("../../stores/sessionStore");
const { applyRdpStatus, applyTerminalStatus } = await import("../sessionStatusEvents");

const session = (id: string) => useSessionStore.getState().sessions.find((s) => s.id === id);

beforeEach(() => {
  invoke.mockClear();
  useSessionStore.setState({
    sessions: [
      { id: "r1", type: "rdp", title: "Office", status: "connected", entryId: "e1" },
      { id: "s1", type: "ssh", title: "web-01", status: "connected", entryId: "e2" },
      { id: "l1", type: "local_shell", title: "Terminal", status: "connected" },
    ],
    activeSessionId: "r1",
  });
});

describe("applyRdpStatus", () => {
  it("closes the tab after a sign-out and lets the helper go", async () => {
    applyRdpStatus({ sessionId: "r1", status: "disconnected", error: null, ended: true });
    await vi.waitFor(() => expect(session("r1")).toBeUndefined());
    expect(invoke).toHaveBeenCalledWith("rdp_disconnect", { sessionId: "r1" });
  });

  it("marks a dropped session disconnected so it can be reconnected", () => {
    applyRdpStatus({ sessionId: "r1", status: "disconnected", error: null, ended: false });
    expect(session("r1")).toMatchObject({ status: "disconnected", error: "Session disconnected" });
  });

  it("leaves a reconnecting session alone", () => {
    useSessionStore.getState().updateSessionMetadata("r1", { reconnecting: true });
    applyRdpStatus({ sessionId: "r1", status: "disconnected", error: null, ended: true });
    expect(session("r1")).toMatchObject({ status: "connected" });
  });
});

describe("applyTerminalStatus", () => {
  it("closes an SSH tab after exit and a local shell after a clean exit", async () => {
    applyTerminalStatus({ sessionId: "s1", status: "disconnected", error: null, ended: true });
    applyTerminalStatus({ sessionId: "l1", status: "disconnected", error: null, ended: false });
    await vi.waitFor(() => expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["r1"]));
  });

  it("keeps the error screen for a dropped SSH session", () => {
    applyTerminalStatus({ sessionId: "s1", status: "disconnected", error: "read ECONNRESET", ended: false });
    expect(session("s1")).toMatchObject({ status: "disconnected", error: "read ECONNRESET" });
  });
});
