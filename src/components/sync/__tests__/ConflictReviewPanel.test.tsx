import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ConflictReviewPanel from "../ConflictReviewPanel";
import ConflictFieldRow from "../ConflictFieldRow";
import { useSyncStore } from "../../../stores/syncStore";
import type { ConflictGroup, FieldConflict, SyncStateResponse } from "../../../types/sync";

const invoke = vi.fn<(channel: string, args?: unknown) => Promise<unknown>>();

const hostField: FieldConflict = {
  key: { tbl: 1, rowId: "e1", reg: "host" },
  label: "Host",
  cls: "prompt",
  secret: false,
  versions: [
    { id: "v1", source: { kind: "device", deviceUuid: "a", deviceName: "MacBook" }, timeMs: 0, value: "10.0.0.5", masked: false, provisional: true, undecryptable: false, redacted: false, olderApp: false },
    { id: "v2", source: { kind: "device", deviceUuid: "b", deviceName: "iPhone" }, timeMs: 0, value: "10.0.0.9", masked: false, provisional: false, undecryptable: false, redacted: false, olderApp: false },
  ],
  staleRevert: false,
  keepBothOffered: false,
  invariantGuard: false,
  snoozeKey: "snooze-host",
};

const groups: ConflictGroup[] = [
  { row: { tbl: 1, rowId: "e1" }, title: "Prod server", items: [{ kind: "field", field: hostField }], snoozed: false },
  { row: { tbl: 1, rowId: "e2" }, title: "Old box", items: [], snoozed: true },
];

const syncState: SyncStateResponse = {
  enabled: true,
  killSwitch: false,
  vault: { lineageId: "L", path: "/v", fileName: "v", shared: true, engine: true },
  status: {
    lineageId: "L", fileName: "v", kind: "up-to-date", pauseReason: null, waiting: null, pendingPublish: false,
    unsyncedOps: 0, conflictCount: 2, lastSyncedMs: null, backoffUntilMs: null, sessionBadge: null,
    networkRoot: false, prompts: [], otherCopies: [],
  },
  deviceLimit: null,
  sideFiles: [],
  notices: [],
  pendingVaults: [],
  softLocked: false,
};

function handler(channel: string): Promise<unknown> {
  if (channel === "sync_list_conflicts") return Promise.resolve(groups);
  if (channel === "sync_resolve" || channel === "sync_snooze" || channel === "sync_resolve_group") return Promise.resolve({ conflictCount: 1 });
  return Promise.resolve(null);
}

beforeEach(() => {
  invoke.mockImplementation(handler);
  window.electron = { platform: "darwin", invoke, send: vi.fn(), on: vi.fn(() => () => {}), removeListener: vi.fn() };
  useSyncStore.setState({ state: syncState, conflicts: groups, view: { kind: "review", row: null } });
});

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

describe("ConflictReviewPanel", () => {
  it("lists items with snoozed ones last and shows the first item's versions", async () => {
    render(<ConflictReviewPanel initialRow={null} />);
    const items = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(items.findIndex((t) => t.includes("Prod server"))).toBeLessThan(items.findIndex((t) => t.includes("Old box")));
    expect(screen.getByText("10.0.0.9")).toBeInTheDocument();
    expect(screen.getByText("In use now")).toBeInTheDocument();
  });

  it("runs Keep newest for all as a bulk group resolution", async () => {
    render(<ConflictReviewPanel initialRow={null} />);
    fireEvent.click(screen.getByText("Keep newest for all"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sync_resolve_group", { request: { kind: "bulk", choice: "keep-newest-all" } }),
    );
  });

  it("opens on the requested row", () => {
    render(<ConflictReviewPanel initialRow={{ tbl: 1, rowId: "e2" }} />);
    expect(screen.getByText("Snoozed on this device. The newest version is in use.")).toBeInTheDocument();
  });
});

describe("ConflictFieldRow", () => {
  it("[Use this] resolves the field with that version", async () => {
    render(<ConflictFieldRow field={hostField} itemTitle="Prod server" />);
    fireEvent.click(screen.getAllByText("Use this")[1]);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sync_resolve", {
        request: { kind: "field", key: hostField.key, choice: { kind: "version", versionId: "v2" } },
      }),
    );
  });

  it("[Decide later] snoozes with the field's key", async () => {
    render(<ConflictFieldRow field={hostField} itemTitle="Prod server" />);
    fireEvent.click(screen.getByText("Decide later"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_snooze", { snoozeKey: "snooze-host" }));
  });

  it("[Enter a different value...] sends the typed value", async () => {
    render(<ConflictFieldRow field={hostField} itemTitle="Prod server" compact />);
    expect(screen.queryByText("Decide later")).toBeNull();
    fireEvent.click(screen.getByText("Enter a different value..."));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "10.0.0.7" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sync_resolve", {
        request: { kind: "field", key: hostField.key, choice: { kind: "value", value: "10.0.0.7" } },
      }),
    );
  });
});
