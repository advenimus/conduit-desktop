import {
  TRIAL_URGENT_DAYS,
  TRIAL_WARN_DAYS,
  type AttentionAction,
  type AttentionItem,
  type AttentionKind,
  type AttentionTone,
  type HomeSettings,
  type PasswordAgeItem,
} from "../../../types/dashboard";
import type { DisplacedEvent, SessionConflictEvent, SyncStateResponse } from "../../../types/sync";
import type { CloudSyncState, LocalBackupState, TeamSyncState } from "../../../stores/vaultStore";
import { activeStatus } from "../../../stores/sync-reducers";
import { DEFAULT_DEVICE_CAP, statusLabel } from "../../sync/sync-copy";
import { formatRelativeTime } from "../relativeTime";

const DAY_MS = 86_400_000;

export interface AttentionInput {
  readonly now: number;
  readonly syncState: SyncStateResponse | null;
  readonly displaced: DisplacedEvent | null;
  readonly sessionConflict: SessionConflictEvent | null;
  readonly teamSyncState: TeamSyncState | null;
  readonly localBackupState: LocalBackupState | null;
  readonly cloudSyncState: CloudSyncState | null;
  readonly authMode: string | null;
  /** null while not loaded or turned off. */
  readonly passwordAges: readonly PasswordAgeItem[] | null;
  /** Ids of the entries that still exist. */
  readonly entryIds: ReadonlySet<string>;
  readonly settings: Pick<HomeSettings, "passwordAgeDays" | "backupStaleDays">;
  readonly maxConnections: number;
  readonly connectionCount: number;
  readonly isTrialing: boolean;
  readonly trialDaysRemaining: number;
}

const ACTION_LABELS: Readonly<Record<AttentionAction, string>> = {
  "review-sync": "Review",
  "open-sync-settings": "Open Sync settings",
  "open-backup-settings": "Open Backup settings",
  "show-passwords": "Show entries",
  "see-plans": "See plans",
};

function item(
  kind: AttentionKind,
  tone: AttentionTone,
  title: string,
  detail: string | null,
  action: AttentionAction | null,
  extra: Pick<AttentionItem, "entryIds"> = {},
): AttentionItem {
  return { kind, tone, title, detail, action, actionLabel: action ? ACTION_LABELS[action] : null, ...extra };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function passwordPeriodText(days: number): string {
  if (days === 365) return "1 year";
  return `${days} days`;
}

/** "3 months" under a year, "1 year", "2 years" after (whole units). */
export function formatAge(fromIso: string, now: number): string {
  const days = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / DAY_MS));
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30));
    return `${months} ${plural(months, "month", "months")}`;
  }
  const years = Math.floor(days / 365);
  return `${years} ${plural(years, "year", "years")}`;
}

function syncItems(input: AttentionInput): AttentionItem[] {
  const status = activeStatus(input.syncState);
  if (!status) return [];
  const killSwitch = input.syncState?.killSwitch ?? false;
  const out: AttentionItem[] = [];
  if (status.conflictCount > 0) {
    const n = status.conflictCount;
    out.push(item("sync-review", "warning", `${n} ${plural(n, "change", "changes")} to review`, "Another device changed the same thing. Pick which to keep.", "review-sync"));
  }
  if (killSwitch || status.kind === "paused") {
    out.push(item("sync-paused", "warning", "Sync is paused", statusLabel(status, killSwitch), "open-sync-settings"));
  } else if (status.kind === "error") {
    out.push(item("sync-error", "danger", "Sync has a problem", statusLabel(status, killSwitch), "open-sync-settings"));
  }
  return out;
}

function staleDays(lastIso: string | null, input: AttentionInput): number | null {
  if (!lastIso) return null;
  const age = input.now - new Date(lastIso).getTime();
  if (!(age > input.settings.backupStaleDays * DAY_MS)) return null;
  return Math.floor(age / DAY_MS);
}

function backupItems(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  const local = input.localBackupState;
  if (local?.enabled) {
    if (local.status === "error") {
      out.push(item("local-backup-failed", "danger", "Local backup failed", local.error, "open-backup-settings"));
    } else {
      const days = staleDays(local.lastBackedUpAt, input);
      if (days !== null) {
        out.push(item("local-backup-stale", "warning", `No local backup in ${days} days`, `Last backup ${formatRelativeTime(local.lastBackedUpAt!, input.now)}.`, "open-backup-settings"));
      }
    }
  }
  const cloud = input.cloudSyncState;
  if (input.authMode !== "local" && cloud?.enabled) {
    if (cloud.status === "error") {
      out.push(item("cloud-backup-failed", "danger", "Cloud backup failed", cloud.error, "open-backup-settings"));
    } else {
      const days = staleDays(cloud.lastSyncedAt, input);
      if (days !== null) {
        out.push(item("cloud-backup-stale", "warning", `No cloud backup in ${days} days`, `Last backup ${formatRelativeTime(cloud.lastSyncedAt!, input.now)}.`, "open-backup-settings"));
      }
    }
  }
  return out;
}

function passwordItem(input: AttentionInput): AttentionItem | null {
  const limitDays = input.settings.passwordAgeDays;
  if (limitDays === null || !input.passwordAges) return null;
  const cutoff = input.now - limitDays * DAY_MS;
  const old = input.passwordAges
    .filter((p) => input.entryIds.has(p.entryId) && new Date(p.setAt).getTime() < cutoff)
    .sort((a, b) => new Date(a.setAt).getTime() - new Date(b.setAt).getTime());
  if (old.length === 0) return null;
  const n = old.length;
  return item(
    "password-age",
    "warning",
    `${n} ${plural(n, "password", "passwords")} older than ${passwordPeriodText(limitDays)}`,
    "Change old passwords to keep your accounts safe.",
    "show-passwords",
    { entryIds: old.map((p) => p.entryId) },
  );
}

function planItems(input: AttentionInput): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (input.maxConnections > 0 && input.connectionCount >= input.maxConnections) {
    out.push(item("connection-limit", "warning", `All ${input.maxConnections} connections on your plan are in use`, "Upgrade to add more.", "see-plans"));
  }
  const capEvent =
    input.displaced?.reason === "device_cap" ? input.displaced : input.sessionConflict?.cause === "device_cap" ? input.sessionConflict : null;
  if (capEvent) {
    out.push(item("device-limit", "warning", "Device limit reached", `Your plan allows ${capEvent.deviceCap ?? DEFAULT_DEVICE_CAP} devices at once.`, "see-plans"));
  }
  const days = input.trialDaysRemaining;
  if (input.isTrialing && days >= 0 && days <= TRIAL_WARN_DAYS) {
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    out.push(item("trial-ending", days <= TRIAL_URGENT_DAYS ? "danger" : "warning", `Your Pro trial ends ${when}`, "Upgrade to keep Pro features.", "see-plans"));
  }
  return out;
}

/** Needs attention (docs/DASHBOARD.md 4.6): danger items first, then warnings, each in table order. */
export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const team: AttentionItem[] =
    input.teamSyncState?.status === "error"
      ? [item("team-sync-error", "danger", "Team sync has a problem", input.teamSyncState.error, null)]
      : [];
  const password = passwordItem(input);
  const all = [...syncItems(input), ...team, ...backupItems(input), ...(password ? [password] : []), ...planItems(input)];
  return [...all.filter((i) => i.tone === "danger"), ...all.filter((i) => i.tone === "warning")];
}
