import type { CloudSyncState, LocalBackupState, TeamSyncState } from "../../stores/vaultStore";
import { CircleFilledIcon } from "../../lib/icons";
import { Card, cx, ListRow, SectionHeader } from "../ui";
import { useDeviceSyncRow, type DashboardRowStatus } from "../sync/useDeviceSyncRow";
import { formatRelativeTime } from "./relativeTime";

// The Open now dot colors (the tab StatusDot); off and idle rows are faint.
const DOT_TONE: Readonly<Record<DashboardRowStatus, string>> = {
  ok: "text-(--c-state-connected)",
  error: "text-(--c-state-error)",
  syncing: "text-(--c-state-connecting)",
  idle: "text-ink-faint",
  disabled: "text-ink-faint",
};

function StatusRow({ label, status, detail }: { label: string; status: DashboardRowStatus; detail: string }) {
  return (
    <ListRow
      leading={
        <span className={cx("flex", DOT_TONE[status])} data-status={status}>
          <CircleFilledIcon size={12} />
        </span>
      }
      meta={<span className="max-w-48 truncate">{detail}</span>}
    >
      {label}
    </ListRow>
  );
}

function cloudStatus(state: CloudSyncState | null): { status: DashboardRowStatus; detail: string } {
  if (!state?.enabled) return { status: "disabled", detail: "Disabled" };
  if (state.status === "error") return { status: "error", detail: state.error ?? "Error" };
  if (state.status === "synced") return { status: "ok", detail: "Synced" };
  if (state.status === "syncing") return { status: "syncing", detail: "Syncing..." };
  return { status: "idle", detail: "Idle" };
}

function localStatus(state: LocalBackupState | null): { status: DashboardRowStatus; detail: string } {
  if (!state?.enabled) return { status: "disabled", detail: "Disabled" };
  if (state.status === "error") return { status: "error", detail: state.error ?? "Error" };
  const status = state.status === "backed-up" ? "ok" : "idle";
  return { status, detail: state.lastBackedUpAt ? `Last: ${formatRelativeTime(state.lastBackedUpAt)}` : "No backups yet" };
}

function teamStatus(state: TeamSyncState): { status: DashboardRowStatus; detail: string } {
  const status = state.status === "error" ? "error" : state.status === "synced" ? "ok" : state.status === "syncing" ? "syncing" : "idle";
  if (state.status === "error") return { status, detail: state.error ?? "Error" };
  if (state.pendingChanges > 0) return { status, detail: `${state.pendingChanges} pending` };
  return { status, detail: state.status === "synced" ? "Synced" : "Idle" };
}

function usageColor(used: number, max: number): string {
  if (used >= max) return "bg-danger";
  if (used > max * 0.8) return "bg-warning";
  return "bg-accent";
}

function trialColor(days: number): string {
  if (days <= 3) return "text-danger";
  if (days <= 7) return "text-warning";
  return "text-link";
}

export default function VaultStatusCard({
  cloudSyncState,
  localBackupState,
  teamSyncState,
  authMode,
  maxConnections,
  connectionCount,
  isTrialing,
  trialDaysRemaining,
}: {
  cloudSyncState: CloudSyncState | null;
  localBackupState: LocalBackupState | null;
  teamSyncState: TeamSyncState | null;
  authMode: string | null;
  maxConnections: number;
  connectionCount: number;
  isTrialing: boolean;
  trialDaysRemaining: number;
}) {
  const deviceSync = useDeviceSyncRow();
  return (
    <Card>
      <SectionHeader title="Vault status" />
      <div className="space-y-px">
        {deviceSync && <StatusRow label="Device sync" status={deviceSync.status} detail={deviceSync.detail} />}

        {authMode !== "local" && <StatusRow label="Cloud backup" {...cloudStatus(cloudSyncState)} />}

        <StatusRow label="Local backup" {...localStatus(localBackupState)} />

        {authMode !== "local" && teamSyncState && <StatusRow label="Team sync" {...teamStatus(teamSyncState)} />}

        {maxConnections > 0 && (
          <div>
            <ListRow meta={`${connectionCount}/${maxConnections}`}>Plan usage</ListRow>
            <div className="mx-2 mb-1 h-1.5 overflow-hidden rounded-full bg-divider">
              <div
                className={`h-full rounded-full transition-all ${usageColor(connectionCount, maxConnections)}`}
                style={{ width: `${Math.min(100, (connectionCount / maxConnections) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {isTrialing && trialDaysRemaining >= 0 && (
          <ListRow
            meta={
              <span className={`font-medium ${trialColor(trialDaysRemaining)}`}>
                {trialDaysRemaining} {trialDaysRemaining === 1 ? "day" : "days"} remaining
              </span>
            }
          >
            Trial
          </ListRow>
        )}
      </div>
    </Card>
  );
}
