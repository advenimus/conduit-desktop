import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryMeta } from "../../types/entry";
import { HARDCODED_RDP_DEFAULTS } from "../../types/entry";

const invoke = vi.fn();
vi.mock("../../lib/electron", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../components/common/Toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("../../components/sessions/TerminalView", () => ({ disposeTerminalEntry: vi.fn() }));

const { useEntryStore } = await import("../entryStore");
const { useSessionStore } = await import("../sessionStore");
const { useSettingsStore } = await import("../settingsStore");
const { useTierStore } = await import("../tierStore");

function rdpEntry(config: Record<string, unknown>): EntryMeta {
  return {
    id: "e1",
    name: "app-01",
    entry_type: "rdp",
    host: "app-01.corp.local",
    port: 3389,
    username: "CORP\\alice",
    domain: null,
    credential_type: null,
    config,
  } as unknown as EntryMeta;
}

const gatewayEntry = {
  id: "g1",
  name: "Office gateway",
  entry_type: "credential",
  credential_type: "rd_gateway",
  username: "CORP\\gwadmin",
  config: { gatewayHostname: "gw.example.com", gatewayPort: 8443, gatewayLoginSource: "own" },
} as unknown as EntryMeta;

function rdpConnectArgs(): Record<string, unknown> {
  const call = invoke.mock.calls.find((c) => c[0] === "rdp_connect");
  if (!call) throw new Error("rdp_connect was not called");
  return call[1] as Record<string, unknown>;
}

async function open(config: Record<string, unknown>, others: EntryMeta[] = [gatewayEntry]) {
  useEntryStore.setState({ entries: [rdpEntry(config), ...others] } as never);
  await useEntryStore.getState().openEntry("e1");
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "entry_resolve_credential") return { source: "inline", username: "CORP\\alice", password: "pw", domain: null };
    if (cmd === "rdp_connect") return { sessionId: "e1", width: 1920, height: 1080, mode: "gfx" };
    return null;
  });
  useSessionStore.setState({ sessions: [], activeSessionId: null });
  useSettingsStore.setState({ sessionDefaultsRdp: { ...HARDCODED_RDP_DEFAULTS } });
  useTierStore.setState({ isEntryLocked: () => false } as never);
});

describe("connectEntry RD Gateway", () => {
  it("sends no gateway id for an entry without a gateway", async () => {
    await open({});
    expect(rdpConnectArgs().gatewayId).toBeUndefined();
    expect(rdpConnectArgs()).not.toHaveProperty("gateway");
  });

  it("sends only the gateway id, never a gateway secret or address", async () => {
    await open({ gatewayId: "g1" });
    const args = rdpConnectArgs();
    expect(args.gatewayId).toBe("g1");
    expect(args).not.toHaveProperty("gateway");
    expect(JSON.stringify(args)).not.toMatch(/gwadmin|gw\.example\.com/);
    expect(invoke.mock.calls.some((c) => c[0] === "credential_get" || c[0] === "entry_get")).toBe(false);
  });

  it("ignores the old per-entry gateway keys", async () => {
    await open({ gatewayMode: "custom", gatewayHostname: "old-gw.example.com" });
    expect(rdpConnectArgs().gatewayId).toBeUndefined();
    expect(JSON.stringify(rdpConnectArgs())).not.toMatch(/old-gw/);
  });

  it("records the gateway's name and address on the session for the connecting screen", async () => {
    await open({ gatewayId: "g1" });
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0]?.status).toBe("connected"));
    expect(useSessionStore.getState().sessions[0].metadata).toMatchObject({
      gatewayId: "g1",
      gatewayName: "Office gateway",
      gatewayHost: "gw.example.com:8443",
    });
  });

  it("still sends the id of a deleted gateway so the main process can explain it", async () => {
    await open({ gatewayId: "gone" }, []);
    expect(rdpConnectArgs().gatewayId).toBe("gone");
    expect(useSessionStore.getState().sessions[0].metadata).toMatchObject({ gatewayId: "gone", gatewayName: null, gatewayHost: null });
  });

  it("shows a gateway setup error from the main process as the connect error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rdp_connect") throw new Error("The gateway this entry uses was deleted. Pick a gateway again in the entry's Gateway settings.");
      return null;
    });
    await open({ gatewayId: "gone" }, []);
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0]?.status).toBe("disconnected"));
    expect(useSessionStore.getState().sessions[0].error).toMatch(/^The gateway this entry uses was deleted/);
  });
});
