import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import SyncLayer from "../SyncLayer";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";

const OLD = "/cloud/Vault.conduit";
const MOVED = "/cloud/Renamed.conduit";
const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const handlers = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  handlers.clear();
  invoke.mockImplementation((channel: string) => Promise.resolve(channel === "settings_get" ? { recent_vaults: [MOVED] } : null));
  const on = vi.fn((channel: string, cb: (payload: unknown) => void) => {
    handlers.set(channel, cb);
    return () => handlers.delete(channel);
  });
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on, removeListener: vi.fn() };
  useSyncStore.setState({ state: null, displaced: null, displacing: null, sessionConflict: null, openWaiting: null, view: null, takeoverMode: false });
  useVaultStore.setState({ currentVaultPath: OLD, recentVaults: [OLD] });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("useSyncEvents: the open vault's file moved (spec 5.9)", () => {
  it("points the vault store and the recent list at the new file", async () => {
    render(<SyncLayer />);
    const moved = handlers.get("vault:path-changed");
    expect(moved).toBeDefined();
    moved?.({ path: MOVED });
    expect(useVaultStore.getState().currentVaultPath).toBe(MOVED);
    await waitFor(() => expect(useVaultStore.getState().recentVaults).toEqual([MOVED]));
    expect(invoke).toHaveBeenCalledWith("settings_get", undefined);
  });

  it("ignores an event without a path", () => {
    render(<SyncLayer />);
    handlers.get("vault:path-changed")?.({});
    expect(useVaultStore.getState().currentVaultPath).toBe(OLD);
  });
});
