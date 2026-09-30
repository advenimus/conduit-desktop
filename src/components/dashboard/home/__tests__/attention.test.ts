import { describe, expect, it } from "vitest";
import { buildAttentionItems, formatAge, passwordPeriodText, type AttentionInput } from "../attention";
import type { SyncStateResponse, SyncStatus } from "../../../../types/sync";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    lineageId: "l1",
    fileName: "Acme.conduit",
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
    ...overrides,
  };
}

function syncState(s: SyncStatus | null, killSwitch = false): SyncStateResponse {
  return { enabled: true, killSwitch, status: s, softLocked: false } as unknown as SyncStateResponse;
}

function input(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    now: NOW,
    syncState: null,
    displaced: null,
    sessionConflict: null,
    teamSyncState: null,
    localBackupState: null,
    cloudSyncState: null,
    authMode: "authenticated",
    passwordAges: null,
    entryIds: new Set(["a", "b", "c"]),
    settings: { passwordAgeDays: 180, backupStaleDays: 7 },
    maxConnections: -1,
    connectionCount: 0,
    isTrialing: false,
    trialDaysRemaining: -1,
    ...overrides,
  };
}

const kinds = (i: AttentionInput) => buildAttentionItems(i).map((x) => x.kind);
const only = (i: AttentionInput) => {
  const items = buildAttentionItems(i);
  expect(items).toHaveLength(1);
  return items[0];
};

const local = (o: object) => ({ status: "backed-up", lastBackedUpAt: daysAgo(1), error: null, enabled: true, backupPath: "/b", retentionDays: 7, ...o }) as AttentionInput["localBackupState"];
const cloud = (o: object) => ({ status: "synced", lastSyncedAt: daysAgo(1), error: null, enabled: true, ...o }) as AttentionInput["cloudSyncState"];

describe("buildAttentionItems", () => {
  it("is empty when all is well", () => {
    expect(buildAttentionItems(input({ syncState: syncState(status()), localBackupState: local({}), cloudSyncState: cloud({}) }))).toEqual([]);
  });

  it("sync review, with pluralization and the Review action", () => {
    expect(only(input({ syncState: syncState(status({ conflictCount: 1 })) }))).toMatchObject({
      kind: "sync-review",
      tone: "warning",
      title: "1 change to review",
      detail: "Another device changed the same thing. Pick which to keep.",
      action: "review-sync",
      actionLabel: "Review",
    });
    expect(only(input({ syncState: syncState(status({ conflictCount: 2 })) })).title).toBe("2 changes to review");
  });

  it("sync paused by kind or kill switch, sync error as danger", () => {
    expect(only(input({ syncState: syncState(status({ kind: "paused", pauseReason: "side-files" })) }))).toMatchObject({
      kind: "sync-paused",
      title: "Sync is paused",
      actionLabel: "Open Sync settings",
    });
    expect(only(input({ syncState: syncState(status(), true) })).detail).toBe("Paused (paused by Conduit)");
    expect(only(input({ syncState: syncState(status({ kind: "error" })) }))).toMatchObject({ kind: "sync-error", tone: "danger", title: "Sync has a problem" });
  });

  it("ignores sync without a running engine", () => {
    expect(buildAttentionItems(input({ syncState: syncState(null, true) }))).toEqual([]);
  });

  it("team sync error has no action", () => {
    expect(only(input({ teamSyncState: { status: "error", error: "Server said no", lastSyncedAt: null, pendingChanges: 0 } }))).toMatchObject({
      kind: "team-sync-error",
      tone: "danger",
      title: "Team sync has a problem",
      detail: "Server said no",
      action: null,
      actionLabel: null,
    });
  });

  it("local backup failed and stale at the threshold", () => {
    expect(only(input({ localBackupState: local({ status: "error", error: "Disk full" }) }))).toMatchObject({
      kind: "local-backup-failed",
      tone: "danger",
      detail: "Disk full",
      actionLabel: "Open Backup settings",
    });
    expect(kinds(input({ localBackupState: local({ lastBackedUpAt: daysAgo(7) }) }))).toEqual([]);
    expect(only(input({ localBackupState: local({ lastBackedUpAt: daysAgo(10) }) }))).toMatchObject({
      kind: "local-backup-stale",
      title: "No local backup in 10 days",
      detail: "Last backup 1w ago.",
    });
    expect(only(input({ localBackupState: local({ lastBackedUpAt: daysAgo(4) }), settings: { passwordAgeDays: 180, backupStaleDays: 3 } })).title).toBe("No local backup in 4 days");
  });

  it("a backup that is off or never ran is not an item", () => {
    expect(kinds(input({ localBackupState: local({ enabled: false, status: "error" }) }))).toEqual([]);
    expect(kinds(input({ localBackupState: local({ lastBackedUpAt: null, status: "idle" }) }))).toEqual([]);
    expect(kinds(input({ cloudSyncState: cloud({ lastSyncedAt: null }) }))).toEqual([]);
  });

  it("cloud backup failed and stale, never in local mode", () => {
    expect(only(input({ cloudSyncState: cloud({ status: "error", error: "Quota" }) }))).toMatchObject({ kind: "cloud-backup-failed", tone: "danger", detail: "Quota" });
    expect(only(input({ cloudSyncState: cloud({ lastSyncedAt: daysAgo(8) }) }))).toMatchObject({ kind: "cloud-backup-stale", title: "No cloud backup in 8 days" });
    expect(kinds(input({ authMode: "local", cloudSyncState: cloud({ status: "error" }) }))).toEqual([]);
  });

  it("password age: existing entries older than the period, oldest first", () => {
    const passwordAges = [
      { entryId: "a", setAt: daysAgo(200), source: "created" as const },
      { entryId: "b", setAt: daysAgo(400), source: "history" as const },
      { entryId: "c", setAt: daysAgo(179), source: "history" as const },
      { entryId: "gone", setAt: daysAgo(900), source: "created" as const },
    ];
    expect(only(input({ passwordAges }))).toMatchObject({
      kind: "password-age",
      tone: "warning",
      title: "2 passwords older than 180 days",
      detail: "Change old passwords to keep your accounts safe.",
      action: "show-passwords",
      actionLabel: "Show",
      entryIds: ["b", "a"],
    });
    expect(only(input({ passwordAges, settings: { passwordAgeDays: 365, backupStaleDays: 7 } })).title).toBe("1 password older than 1 year");
    expect(only(input({ passwordAges, settings: { passwordAgeDays: 90, backupStaleDays: 7 } })).title).toBe("3 passwords older than 90 days");
    expect(kinds(input({ passwordAges, settings: { passwordAgeDays: null, backupStaleDays: 7 } }))).toEqual([]);
    expect(kinds(input({ passwordAges: [] }))).toEqual([]);
  });

  it("connection limit at the plan maximum", () => {
    expect(kinds(input({ maxConnections: 5, connectionCount: 4 }))).toEqual([]);
    expect(only(input({ maxConnections: 5, connectionCount: 5 }))).toMatchObject({
      kind: "connection-limit",
      title: "All 5 connections on your plan are in use",
      detail: "Upgrade to add more.",
      actionLabel: "See plans",
    });
    expect(kinds(input({ maxConnections: -1, connectionCount: 50 }))).toEqual([]);
  });

  it("device limit from the displaced or session conflict event", () => {
    const displaced = { reason: "device_cap", deviceCap: 3 } as AttentionInput["displaced"];
    expect(only(input({ displaced }))).toMatchObject({ kind: "device-limit", title: "Device limit reached", detail: "Your plan allows 3 devices at once." });
    const sessionConflict = { cause: "device_cap", deviceCap: null } as AttentionInput["sessionConflict"];
    expect(only(input({ sessionConflict })).detail).toBe("Your plan allows 5 devices at once.");
    expect(kinds(input({ displaced: { reason: "takeover", deviceCap: 3 } as AttentionInput["displaced"] }))).toEqual([]);
  });

  it("trial ending: wording and tone by days left", () => {
    const trial = (days: number) => buildAttentionItems(input({ isTrialing: true, trialDaysRemaining: days }));
    expect(trial(8)).toEqual([]);
    expect(trial(7)[0]).toMatchObject({ tone: "warning", title: "Your Pro trial ends in 7 days", detail: "Upgrade to keep Pro features." });
    expect(trial(4)[0].tone).toBe("warning");
    expect(trial(3)[0]).toMatchObject({ tone: "danger", title: "Your Pro trial ends in 3 days" });
    expect(trial(1)[0].title).toBe("Your Pro trial ends tomorrow");
    expect(trial(0)[0].title).toBe("Your Pro trial ends today");
    expect(trial(-1)).toEqual([]);
    expect(buildAttentionItems(input({ isTrialing: false, trialDaysRemaining: 2 }))).toEqual([]);
  });

  it("orders danger items first, then warnings, each in table order", () => {
    const all = input({
      syncState: syncState(status({ conflictCount: 2, kind: "error" })),
      teamSyncState: { status: "error", error: "x", lastSyncedAt: null, pendingChanges: 0 },
      localBackupState: local({ lastBackedUpAt: daysAgo(30) }),
      cloudSyncState: cloud({ status: "error", error: "y" }),
      passwordAges: [{ entryId: "a", setAt: daysAgo(300), source: "created" }],
      maxConnections: 1,
      connectionCount: 1,
      displaced: { reason: "device_cap", deviceCap: 2 } as AttentionInput["displaced"],
      isTrialing: true,
      trialDaysRemaining: 2,
    });
    expect(kinds(all)).toEqual([
      "sync-error",
      "team-sync-error",
      "cloud-backup-failed",
      "trial-ending",
      "sync-review",
      "local-backup-stale",
      "password-age",
      "connection-limit",
      "device-limit",
    ]);
  });
});

describe("formatAge and passwordPeriodText", () => {
  it("uses whole months under a year and whole years after", () => {
    expect(formatAge(daysAgo(95), NOW)).toBe("3 months");
    expect(formatAge(daysAgo(20), NOW)).toBe("1 month");
    expect(formatAge(daysAgo(364), NOW)).toBe("12 months");
    expect(formatAge(daysAgo(365), NOW)).toBe("1 year");
    expect(formatAge(daysAgo(800), NOW)).toBe("2 years");
  });

  it("names the periods", () => {
    expect([90, 180, 365].map(passwordPeriodText)).toEqual(["90 days", "180 days", "1 year"]);
  });
});
