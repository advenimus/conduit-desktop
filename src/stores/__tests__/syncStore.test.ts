import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSyncStore } from "../syncStore";
import type { ConflictGroup, SyncStateResponse, SyncStatus } from "../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    lineageId: "L1", fileName: "V.conduit", kind: "up-to-date", pauseReason: null, waiting: null,
    pendingPublish: false, unsyncedOps: 0, conflictCount: 0, lastSyncedMs: null, backoffUntilMs: null,
    sessionBadge: null, networkRoot: false, prompts: [], otherCopies: [], ...over,
  };
}

function state(over: Partial<SyncStateResponse> = {}): SyncStateResponse {
  return {
    enabled: true, killSwitch: false,
    vault: { lineageId: "L1", path: "/V.conduit", fileName: "V.conduit", shared: true, engine: true },
    status: status(), deviceLimit: null, sideFiles: [], notices: [], pendingVaults: [], softLocked: false, ...over,
  };
}

const groups: ConflictGroup[] = [{ row: { tbl: 1, rowId: "e1" }, title: "Prod", items: [], snoozed: false }];

beforeEach(() => {
  invoke.mockReset();
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useSyncStore.setState({ state: null, conflicts: [], conflictKeys: new Set(), view: null, deferredPrompts: new Set() });
});

describe("syncStore", () => {
  it("refresh reads the state and loads conflicts when there are some", async () => {
    invoke.mockImplementation((ch) =>
      Promise.resolve(ch === "sync_get_state" ? state({ status: status({ conflictCount: 1 }) }) : groups),
    );
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().state?.status?.conflictCount).toBe(1);
    expect(useSyncStore.getState().conflictKeys.has("1:e1")).toBe(true);
  });

  it("skips listing conflicts when none are reported", async () => {
    invoke.mockResolvedValue(state());
    await useSyncStore.getState().refresh();
    expect(invoke).not.toHaveBeenCalledWith("sync_list_conflicts", undefined);
    expect(useSyncStore.getState().conflicts).toEqual([]);
  });

  it("applyStatus updates in place, and refreshes for an unknown vault", () => {
    useSyncStore.setState({ state: state() });
    invoke.mockResolvedValue(state());
    useSyncStore.getState().applyStatus(status({ kind: "syncing" }));
    expect(useSyncStore.getState().state?.status?.kind).toBe("syncing");
    expect(invoke).not.toHaveBeenCalled();
    useSyncStore.getState().applyStatus(status({ lineageId: "other" }));
    expect(invoke).toHaveBeenCalledWith("sync_get_state", undefined);
  });

  it("applyStatus refreshes when the side-files prompt appears or changes, so its file tuples are current", async () => {
    const sideFiles = [{ name: "wal" as const, exists: true, size: 0, mtimeMs: 1 }, { name: "shm" as const, exists: true, size: 32768, mtimeMs: 1 }];
    const prompt = (walNonEmpty: boolean) => ({ kind: "side-files" as const, id: "side-files", upgradeWording: false, walNonEmpty });
    useSyncStore.setState({ state: state() });
    invoke.mockResolvedValue(state({ status: status({ prompts: [prompt(false)] }), sideFiles }));
    useSyncStore.getState().applyStatus(status({ prompts: [prompt(false)] }));
    expect(invoke).toHaveBeenCalledWith("sync_get_state", undefined);
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().state?.sideFiles).toEqual(sideFiles);
    invoke.mockClear();
    useSyncStore.getState().applyStatus(status({ kind: "syncing", prompts: [prompt(false)] }));
    expect(invoke).not.toHaveBeenCalled();
    useSyncStore.getState().applyStatus(status({ prompts: [prompt(true)] }));
    expect(invoke).toHaveBeenCalledWith("sync_get_state", undefined);
  });

  it("dismissPrompt calls main and drops the prompt locally", async () => {
    useSyncStore.setState({ state: state({ status: status({ prompts: [{ kind: "epoch-legacy", id: "epoch-legacy" }] }) }) });
    invoke.mockResolvedValue(undefined);
    await useSyncStore.getState().dismissPrompt("epoch-legacy");
    expect(invoke).toHaveBeenCalledWith("sync_dismiss_prompt", { promptId: "epoch-legacy" });
    expect(useSyncStore.getState().state?.status?.prompts).toEqual([]);
  });

  it("resetForLock forgets the engine status and open panels", () => {
    useSyncStore.setState({ state: state(), view: { kind: "recently-deleted" }, conflicts: groups });
    useSyncStore.getState().resetForLock();
    const s = useSyncStore.getState();
    expect(s.state?.status).toBeNull();
    expect(s.state?.enabled).toBe(true);
    expect(s.view).toBeNull();
    expect(s.conflicts).toEqual([]);
  });
});
