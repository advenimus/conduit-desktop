import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryMeta, RdpEntryConfig } from "../../types/entry";
import { HARDCODED_RDP_DEFAULTS } from "../../types/entry";

const invoke = vi.fn();
vi.mock("../../lib/electron", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../components/common/Toast", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("../../components/sessions/TerminalView", () => ({ disposeTerminalEntry: vi.fn() }));

const { useEntryStore } = await import("../entryStore");
const { useSessionStore } = await import("../sessionStore");
const { useSettingsStore } = await import("../settingsStore");
const { useTierStore } = await import("../tierStore");

function rdpEntry(config: Partial<RdpEntryConfig>): EntryMeta {
  return {
    id: "e1",
    name: "app-01",
    entry_type: "rdp",
    host: "app-01.corp.local",
    port: 3389,
    username: "CORP\\alice",
    domain: null,
    config,
  } as unknown as EntryMeta;
}

function rdpConnectArgs(): Record<string, unknown> {
  const call = invoke.mock.calls.find((c) => c[0] === "rdp_connect");
  if (!call) throw new Error("rdp_connect was not called");
  return call[1] as Record<string, unknown>;
}

async function open(config: Partial<RdpEntryConfig>) {
  useEntryStore.setState({ entries: [rdpEntry(config)] } as never);
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
  it("sends gateway null when no gateway applies", async () => {
    await open({});
    expect(rdpConnectArgs().gateway).toBeNull();
  });

  it("sends the Settings default for an entry on the default", async () => {
    useSettingsStore.setState({
      sessionDefaultsRdp: { ...HARDCODED_RDP_DEFAULTS, gatewayEnabled: true, gatewayHostname: "gw.example.com" },
    });
    await open({});
    expect(rdpConnectArgs().gateway).toEqual({
      hostname: "gw.example.com",
      port: 443,
      transport: "auto",
      bypassLocal: false,
      credentialMode: "same",
      credentialId: undefined,
      source: "default",
    });
  });

  it("sends a custom gateway with its linked credential id and no password", async () => {
    await open({
      gatewayMode: "custom",
      gatewayHostname: "gw2.example.com:8443",
      gatewayCredentialMode: "credential",
      gatewayCredentialId: "c9",
    });
    const gateway = rdpConnectArgs().gateway as Record<string, unknown>;
    expect(gateway).toMatchObject({ hostname: "gw2.example.com", port: 8443, credentialMode: "credential", credentialId: "c9", source: "entry" });
    expect(JSON.stringify(gateway)).not.toMatch(/password/i);
    expect(invoke.mock.calls.some((c) => c[0] === "credential_get")).toBe(false);
  });

  it("sends gateway null when the entry turns the gateway off", async () => {
    useSettingsStore.setState({
      sessionDefaultsRdp: { ...HARDCODED_RDP_DEFAULTS, gatewayEnabled: true, gatewayHostname: "gw.example.com" },
    });
    await open({ gatewayMode: "off" });
    expect(rdpConnectArgs().gateway).toBeNull();
  });

  it("records the gateway host on the session for the connecting screen", async () => {
    await open({ gatewayMode: "custom", gatewayHostname: "gw.example.com" });
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0]?.status).toBe("connected"));
    expect(useSessionStore.getState().sessions[0].metadata?.gatewayHost).toBe("gw.example.com");
  });

  it("shows a gateway setup error from the main process as the connect error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "rdp_connect") throw new Error("The gateway needs a login. Add a username and password to this entry, or pick a saved gateway login in its Gateway settings.");
      return null;
    });
    await open({ gatewayMode: "custom", gatewayHostname: "gw.example.com" });
    await vi.waitFor(() => expect(useSessionStore.getState().sessions[0]?.status).toBe("disconnected"));
    expect(useSessionStore.getState().sessions[0].error).toMatch(/^The gateway needs a login/);
  });
});
