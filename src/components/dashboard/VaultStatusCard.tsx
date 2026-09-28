import type { CloudSyncState, LocalBackupState, TeamSyncState } from "../../stores/vaultStore";
import { Card, SectionHeader } from "../ui";
import { useDeviceSyncRow, type DashboardRowStatus } from "../sync/useDeviceSyncRow";
import { formatRelativeTime } from "./relativeTime";

const DOT_COLOR: Readonly<Record<DashboardRowStatus, string>> = {
  ok: "bg-(--c-state-connected)",
  error: "bg-(--c-state-error)",
  syncing: "bg-(--c-state-connecting)",
  idle: "bg-ink-faint",
  disabled: "bg-ink-faint",
};

function StatusRow({ label, status, detail }: { label: string; status: DashboardRowStatus; detail: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${DOT_COLOR[status]}`} />
        <span className="text-label text-ink">{label}</span>
      </div>
      <span className="text-label text-ink-muted truncate ml-2">{detail}</span>
    </div>
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
      <SectionHeader title="Vault Status" />
      <div className="space-y-2.5">
        {deviceSync && <StatusRow label="Device Sync" status={deviceSync.status} detail={deviceSync.detail} />}

        {authMode !== "local" && <StatusRow label="Cloud Backup" {...cloudStatus(cloudSyncState)} />}

        <StatusRow label="Local Backup" {...localStatus(localBackupState)} />

        {authMode !== "local" && teamSyncState && <StatusRow label="Team Sync" {...teamStatus(teamSyncState)} />}

        {maxConnections > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-label text-ink-muted">Plan Usage</span>
              <span className="text-label text-ink-muted">
                {connectionCount}/{maxConnections}
              </span>
            </div>
            <div className="h-1.5 bg-divider rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${usageColor(connectionCount, maxConnections)}`}
                style={{ width: `${Math.min(100, (connectionCount / maxConnections) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {isTrialing && trialDaysRemaining >= 0 && (
          <div className="flex items-center justify-between pt-1 border-t border-divider">
            <span className="text-label text-ink-muted">Trial</span>
            <span className={`text-label font-medium ${trialColor(trialDaysRemaining)}`}>
              {trialDaysRemaining} {trialDaysRemaining === 1 ? "day" : "days"} remaining
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
