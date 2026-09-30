import { describe, it, expect } from "vitest";
import { busyText, deviceLimitText, formatAgo, holderBusyText, providerName, providerPlace, statusLabel, stillRunningText } from "../sync-copy";
import { transientToast, persistedToast } from "../sync-notices";
import { displacedCopy, displacedDetails } from "../DisplacedDialog";
import { waitingText } from "../WaitingForDriveDialog";
import { differentCopiesText } from "../DifferentCopiesDialog";
import { sideFilesText } from "../SideFilesPausedBanner";
import { winnerEpochFor } from "../EpochPromptDialog";
import { copyText } from "../PromptBanner";
import { openErrorLine } from "../UnlockErrorView";
import type { DisplacedEvent, SyncStatus } from "../../../types/sync";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const EM_DASH = "\u2014";

function status(over: Partial<SyncStatus>): SyncStatus {
  return {
    lineageId: "L",
    fileName: null,
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

function displaced(over: Partial<DisplacedEvent>): DisplacedEvent {
  return { lineageId: "L", reason: "takeover", byDeviceName: "iPhone", openConnections: 3, runningJobs: 0, changesSaved: true, fileName: null, ...over };
}

describe("formatAgo and small words", () => {
  it("says seconds, minutes and hours ago", () => {
    expect(formatAgo(NOW - 20_000, NOW)).toBe("20 seconds ago");
    expect(formatAgo(NOW - 2 * 60_000, NOW)).toBe("2 minutes ago");
    expect(formatAgo(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
  });

  it("names providers and device limits", () => {
    expect(providerName("icloud:Documents")).toBe("iCloud Drive");
    expect(providerName("dropbox")).toBe("Dropbox");
    expect(providerName(null)).toBe("another folder");
    expect(providerName("smb:Backups")).toBe("an external or network drive");
    expect(providerPlace("smb:Backups")).toBe("on an external or network drive");
    expect(providerPlace("icloud:Documents")).toBe("in iCloud Drive");
    expect(providerPlace(null)).toBe("in another folder");
    expect(deviceLimitText(1)).toBe("on one device at a time");
    expect(deviceLimitText({ limit: -1, source: "dev-override" })).toBe("on any number of devices at once");
  });

  it("describes busy devices", () => {
    expect(busyText(3, 1)).toBe("3 open connections and an AI task running");
    expect(busyText(0, 0)).toBeNull();
  });

  it("says is or are, It or They, by how many things keep running", () => {
    expect(holderBusyText("MacBook", 3, 1)).toBe("MacBook has 3 open connections and an AI task running. They keep running; only the vault locks.");
    expect(holderBusyText("MacBook", 1, 0)).toBe("MacBook has 1 open connection. It keeps running; only the vault locks.");
    expect(holderBusyText("MacBook", 0, 1)).toBe("MacBook has an AI task running. It keeps running; only the vault locks.");
    expect(holderBusyText("MacBook", 0, 0)).toBeNull();
    expect(stillRunningText(0, 1)).toBe("Your 1 AI task is still running.");
    expect(stillRunningText(0, 2)).toBe("Your 2 AI tasks are still running.");
    expect(stillRunningText(1, 0)).toBe("Your 1 open connection is still running.");
    expect(stillRunningText(1, 1)).toBe("Your 1 open connection and 1 AI task are still running.");
    expect(stillRunningText(3, 2)).toBe("Your 3 open connections and 2 AI tasks are still running.");
    expect(stillRunningText(0, 0)).toBeNull();
  });
});

describe("statusLabel (sidebar indicator)", () => {
  it("covers every status in plain words", () => {
    expect(statusLabel(status({ kind: "up-to-date" }), false)).toBe("Up to date");
    expect(statusLabel(status({ kind: "pending", unsyncedOps: 4 }), false)).toBe("4 changes not yet synced");
    expect(statusLabel(status({ kind: "paused", pauseReason: "side-files" }), false)).toBe("Paused (older Conduit open)");
    expect(statusLabel(status({ kind: "file-not-found" }), false)).toBe("File not found");
    expect(statusLabel(status({ kind: "up-to-date" }), true)).toBe("Paused (paused by Conduit)");
    const waiting = { purpose: "stale-file" as const, devices: [{ deviceId: "d", deviceName: "MacBook", savedAtMs: null }], blocking: false, stopOffered: false, sinceMs: 0 };
    expect(statusLabel(status({ kind: "waiting", waiting }), false)).toBe("Waiting for MacBook");
  });
});

describe("dialog and toast copy", () => {
  it("words the displacement per reason (spec 6.6)", () => {
    expect(displacedCopy(displaced({ reason: "takeover" })).body).toBe("This vault is now open on iPhone.");
    expect(displacedCopy(displaced({ reason: "plan_limit", byDeviceName: "MacBook" })).upgrade).toBe(true);
    expect(displacedDetails(displaced({}))).toEqual([
      "Your changes from this device were saved.",
      "Your 3 open connections are still running.",
    ]);
    expect(displacedDetails(displaced({ changesSaved: false, openConnections: 1 }))[1]).toBe("Your 1 open connection is still running.");
    expect(displacedDetails(displaced({ openConnections: 0, runningJobs: 1 }))).toEqual([
      "Your changes from this device were saved.",
      "Your 1 AI task is still running.",
    ]);
    expect(displacedDetails(displaced({ openConnections: 3, runningJobs: 1 }))[1]).toBe("Your 3 open connections and 1 AI task are still running.");
    expect(displacedDetails(displaced({ openConnections: 0 }))).toEqual(["Your changes from this device were saved."]);
  });

  it("words transient notices", () => {
    const base = { id: "t", createdMs: 0 };
    expect(transientToast({ ...base, kind: "copy-merged", params: { provider: "dropbox", name: "Vault (conflicted copy).conduit" } }).title).toBe(
      "Merged changes from a copy Dropbox made.",
    );
    expect(transientToast({ ...base, kind: "rebound", params: { from: "a", to: "b" } }).action).toBe("undo-rebind");
    expect(transientToast({ ...base, kind: "pending-at-start", params: { count: 12 } }).title).toBe("12 changes exist only on this device.");
    expect(persistedToast({ id: "n", kind: "dropped-setting", key: null, createdMs: 0, sourceSha256: null, count: 1 })).toBeNull();
  });

  it("words waits, copies and side files", () => {
    const w = { purpose: "stale-file" as const, devices: [{ deviceId: "d", deviceName: "MacBook", savedAtMs: NOW - 120_000 }], blocking: true, stopOffered: false, sinceMs: 0 };
    expect(waitingText(w, NOW)).toBe("Getting the latest version from MacBook (saved 2 minutes ago)...");
    const prompt = {
      kind: "different-copies" as const,
      id: "p",
      deviceUuid: "u",
      deviceName: "MacBook",
      theirs: { file_id: "a", location: "icloud:Docs", file_name: "Vault.conduit" },
      ours: { file_id: "b", location: "onedrive:Docs", file_name: "Vault.conduit" },
    };
    expect(differentCopiesText(prompt)).toContain("MacBook syncs 'Vault.conduit' in iCloud Drive.");
    expect(sideFilesText({ kind: "side-files", id: "side-files", upgradeWording: true, walNonEmpty: false })).toMatch(/choose Continue/);
  });

  it("counts a copy's changes, and never says 0 changes", () => {
    expect(copyText(17, 15)).toBe("with 17 changes that aren't in your vault, including 15 deletions");
    expect(copyText(1, 0)).toBe("with 1 change that isn't in your vault");
    expect(copyText(0, 0)).toBe("that may hold changes that aren't in your vault");
  });

  it("maps the concurrent-password choice to [own, other]", () => {
    const prompt = { kind: "epoch-concurrent" as const, id: "epoch-concurrent", epochIds: ["own", "other"] };
    expect(winnerEpochFor(prompt, "this-device")).toBe("own");
    expect(winnerEpochFor(prompt, "other")).toBe("other");
  });

  it("gives unreadable and foreign files a line of text", () => {
    expect(openErrorLine({ code: "VAULT_FILE_UNREADABLE", fileName: "V.conduit", reason: "x" })).toMatch(/can't read 'V.conduit'/);
    expect(openErrorLine({ code: "VAULT_FOREIGN_FILE", fileName: "V.conduit", kind: "newer-format", syncFormat: 2 })).toMatch(/newer version/);
    expect(openErrorLine({ code: "VAULT_WORKING_COPY_DAMAGED", fileName: "V", recoverable: true })).toBeNull();
  });

  it("never uses an em dash", () => {
    const texts = [
      displacedCopy(displaced({ reason: "owner_claim" })).body,
      waitingText({ purpose: "first-genesis", devices: [], blocking: true, stopOffered: false, sinceMs: 0 }),
      statusLabel(status({ kind: "error" }), false),
    ];
    texts.forEach((t) => expect(t).not.toContain(EM_DASH));
  });
});
