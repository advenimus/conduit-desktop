import { describe, it, expect } from "vitest";
import {
  activeStatus,
  conflictRowKeys,
  currentWaiting,
  groupsForRow,
  isPendingPath,
  orderGroups,
  sideFilesPromptChanged,
  visiblePrompts,
  withConflictCount,
  withNotice,
  withoutNotice,
  withoutPrompt,
  withoutStatus,
  withStatus,
} from "../sync-reducers";
import type { ConflictGroup, LocalNotice, SyncStateResponse, SyncStatus, WaitingForDriveState } from "../../types/sync";

function status(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    lineageId: "L1",
    fileName: "Vault.conduit",
    kind: "up-to-date",
    pauseReason: null,
    waiting: null,
    pendingPublish: false,
    unsyncedOps: 0,
    conflictCount: 0,
    lastSyncedMs: null,
    backoffUntilMs: null,
    sessionBadge: null,
    networkRoot: false,
    prompts: [],
    otherCopies: [],
    ...over,
  };
}

function state(over: Partial<SyncStateResponse> = {}): SyncStateResponse {
  return {
    enabled: true,
    killSwitch: false,
    vault: { lineageId: "L1", path: "/d/Vault.conduit", fileName: "Vault.conduit", shared: true, engine: true },
    status: status(),
    deviceLimit: { limit: -1, source: "server" },
    sideFiles: [],
    notices: [],
    pendingVaults: [],
    softLocked: false,
    ...over,
  };
}

function group(tbl: 1 | 2, rowId: string, snoozed = false): ConflictGroup {
  return { row: { tbl, rowId }, title: rowId, items: [], snoozed };
}

const notice: LocalNotice = { id: "n1", kind: "mass-change", key: null, createdMs: 1, sourceSha256: null, count: 42 };

describe("withStatus", () => {
  it("replaces the status of the same vault without mutating the input", () => {
    const prev = state();
    const next = withStatus(prev, status({ kind: "syncing" }));
    expect(next?.status?.kind).toBe("syncing");
    expect(prev.status?.kind).toBe("up-to-date");
  });

  it("returns null for another vault or no state, so the store refreshes", () => {
    expect(withStatus(state(), status({ lineageId: "L2" }))).toBeNull();
    expect(withStatus(null, status())).toBeNull();
  });
});

describe("withConflictCount", () => {
  it("updates the count for the same lineage only", () => {
    expect(withConflictCount(state(), { lineageId: "L1", count: 3 })?.status?.conflictCount).toBe(3);
    const prev = state();
    expect(withConflictCount(prev, { lineageId: "L2", count: 3 })).toBe(prev);
  });
});

describe("notices and prompts", () => {
  it("upserts and removes notices by id", () => {
    const added = withNotice(state(), notice);
    expect(added?.notices).toHaveLength(1);
    expect(withNotice(added, { ...notice, count: 5 })?.notices).toEqual([{ ...notice, count: 5 }]);
    expect(withoutNotice(added, "n1")?.notices).toEqual([]);
  });

  it("drops an answered prompt and hides deferred ones", () => {
    const prompts = [
      { kind: "file-missing", id: "file-missing", path: "/x" },
      { kind: "epoch-legacy", id: "epoch-legacy" },
    ] as const;
    const s = state({ status: status({ prompts }) });
    expect(withoutPrompt(s, "file-missing")?.status?.prompts.map((p) => p.id)).toEqual(["epoch-legacy"]);
    expect(visiblePrompts(s, new Set(["epoch-legacy"])).map((p) => p.id)).toEqual(["file-missing"]);
  });
});

describe("activeStatus and withoutStatus", () => {
  it("is null while soft-locked", () => {
    expect(activeStatus(state({ softLocked: true }))).toBeNull();
    expect(activeStatus(state())).not.toBeNull();
  });

  it("clears the engine parts on lock and keeps the toggle and pending list", () => {
    const pending = [{ lineageId: "L9", sharedPath: "/d/Other.conduit", fileName: "Other.conduit" }];
    const locked = withoutStatus(state({ notices: [notice], pendingVaults: pending }));
    expect(locked?.status).toBeNull();
    expect(locked?.notices).toEqual([]);
    expect(locked?.pendingVaults).toEqual(pending);
    expect(locked?.enabled).toBe(true);
  });
});

describe("conflict groups", () => {
  it("keys rows by table and id", () => {
    const keys = conflictRowKeys([group(1, "a"), group(2, "a")]);
    expect(keys.has("1:a")).toBe(true);
    expect(keys.has("2:a")).toBe(true);
    expect(keys.has("1:b")).toBe(false);
  });

  it("finds groups for one row and orders snoozed groups last", () => {
    const groups = [group(1, "a", true), group(1, "b"), group(2, "a")];
    expect(groupsForRow(groups, { tbl: 1, rowId: "a" })).toHaveLength(1);
    expect(orderGroups(groups).map((g) => g.row.rowId + g.row.tbl)).toEqual(["b1", "a2", "a1"]);
  });
});

describe("currentWaiting and isPendingPath", () => {
  const wait: WaitingForDriveState = { purpose: "stale-file", devices: [], blocking: true, stopOffered: false, sinceMs: 0 };

  it("prefers the unlock-time wait", () => {
    const running = state({ status: status({ waiting: { ...wait, purpose: "first-genesis" } }) });
    expect(currentWaiting(wait, running)).toBe(wait);
    expect(currentWaiting(null, running)?.purpose).toBe("first-genesis");
  });

  it("matches pending vaults by path, ignoring separators and case", () => {
    const s = state({ pendingVaults: [{ lineageId: "L1", sharedPath: "C:\\Users\\Me\\Vault.conduit", fileName: null }] });
    expect(isPendingPath(s, "c:/users/me/vault.conduit")).toBe(true);
    expect(isPendingPath(s, "C:/Users/Me/Other.conduit")).toBe(false);
  });
});

describe("sideFilesPromptChanged", () => {
  const sf = (walNonEmpty: boolean, upgradeWording = false) => ({ kind: "side-files" as const, id: "side-files", walNonEmpty, upgradeWording });
  it("is true when the prompt appears or its wording or WAL flag changes", () => {
    expect(sideFilesPromptChanged(null, status({ prompts: [sf(false)] }))).toBe(true);
    expect(sideFilesPromptChanged(status(), status({ prompts: [sf(false)] }))).toBe(true);
    expect(sideFilesPromptChanged(status({ prompts: [sf(false)] }), status({ prompts: [sf(true)] }))).toBe(true);
    expect(sideFilesPromptChanged(status({ prompts: [sf(false)] }), status({ prompts: [sf(false, true)] }))).toBe(true);
  });
  it("is false while the same prompt stays or when there is none", () => {
    expect(sideFilesPromptChanged(status({ prompts: [sf(false)] }), status({ kind: "syncing", prompts: [sf(false)] }))).toBe(false);
    expect(sideFilesPromptChanged(status({ prompts: [sf(false)] }), status())).toBe(false);
    expect(sideFilesPromptChanged(null, status())).toBe(false);
  });
});
