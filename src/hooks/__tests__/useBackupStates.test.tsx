import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, waitFor, act } from "@testing-library/react";
import { useBackupStates } from "../useBackupStates";
import { useVaultStore, type CloudSyncState, type LocalBackupState } from "../../stores/vaultStore";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();
const listeners = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  listeners.clear();
  window.electron = {
    platform: "darwin",
    invoke,
    send: vi.fn(),
    on: vi.fn((channel: string, cb: (payload: unknown) => void) => {
      listeners.set(channel, cb);
      return () => listeners.delete(channel);
    }),
    removeListener: vi.fn(),
  };
  useVaultStore.setState({ cloudSyncState: null, localBackupState: null });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("useBackupStates", () => {
  it("loads both backup states and follows their changes without the sidebar or Settings mounted", async () => {
    const cloud: CloudSyncState = { status: "synced", lastSyncedAt: "2026-09-26T12:00:00Z", error: null, enabled: true };
    const local: LocalBackupState = { status: "backed-up", lastBackedUpAt: "2026-09-26T12:00:00Z", error: null, enabled: true, backupPath: "/b", retentionDays: 30 };
    invoke.mockImplementation(async (channel) => (channel === "cloud_sync_get_state" ? cloud : channel === "local_backup_get_state" ? local : null));
    const hook = renderHook(() => useBackupStates());
    await waitFor(() => expect(useVaultStore.getState().cloudSyncState).toEqual(cloud));
    await waitFor(() => expect(useVaultStore.getState().localBackupState).toEqual(local));
    act(() => listeners.get("cloud-sync:state-changed")?.({ ...cloud, status: "syncing" }));
    act(() => listeners.get("local-backup:state-changed")?.({ ...local, status: "backing-up" }));
    expect(useVaultStore.getState().cloudSyncState?.status).toBe("syncing");
    expect(useVaultStore.getState().localBackupState?.status).toBe("backing-up");
    hook.unmount();
    expect(listeners.size).toBe(0);
  });
});
