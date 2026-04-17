import { useEffect } from "react";
import { useVaultStore, type TeamSyncState } from "../../stores/vaultStore";
import { AlertTriangleIcon, UsersIcon, WifiOffIcon } from "../../lib/icons";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function TeamSyncIndicator() {
  const { vaultType, teamSyncState, setTeamSyncState, fetchTeamSyncState, syncFailures, setSyncFailures } = useVaultStore();

  // Listen for state-changed events from main process
  useEffect(() => {
    if (vaultType !== "team") return;

    const unlistenState = window.electron.on(
      "vault:sync-state-changed",
      (state: unknown) => {
        setTeamSyncState(state as TeamSyncState);
      }
    );

    const unlistenFailures = window.electron.on(
      "vault:sync-failures",
      (data: unknown) => {
        const { count } = data as { count: number };
        setSyncFailures(count);
      }
    );

    fetchTeamSyncState();
    return () => {
      unlistenState();
      unlistenFailures();
    };
  }, [vaultType, setTeamSyncState, setSyncFailures, fetchTeamSyncState]);

  if (vaultType !== "team" || !teamSyncState) {
    return null;
  }

  const { status, lastSyncedAt, error, pendingChanges } = teamSyncState;

  if (status === "synced") {
    return (
      <div className="flex items-center gap-0.5">
        <div
          className="p-1 text-blue-400"
          title={`Team vault synced${lastSyncedAt ? `: ${formatTime(lastSyncedAt)}` : ""}`}
        >
          <UsersIcon size={14} />
        </div>
        {syncFailures > 0 && (
          <div
            className="p-1 text-amber-400"
            title={`${syncFailures} item${syncFailures === 1 ? "" : "s"} failed to sync — will retry automatically`}
          >
            <AlertTriangleIcon size={12} />
          </div>
        )}
      </div>
    );
  }

  if (status === "syncing") {
    return (
      <div className="p-1 text-blue-400 animate-pulse" title="Syncing team vault...">
        <UsersIcon size={14} />
      </div>
    );
  }

  if (status === "offline") {
    return (
      <div
        className="p-1 text-amber-400"
        title={`Team vault offline${pendingChanges > 0 ? ` (${pendingChanges} pending changes)` : ""}`}
      >
        <WifiOffIcon size={14} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center gap-0.5">
        <div
          className="p-1 text-red-400"
          title={`Team sync error: ${error ?? "Unknown error"}`}
        >
          <AlertTriangleIcon size={14} />
        </div>
        {syncFailures > 0 && (
          <span
            className="text-[10px] text-amber-400"
            title={`${syncFailures} item${syncFailures === 1 ? "" : "s"} failed to sync — will retry automatically`}
          >
            {syncFailures}
          </span>
        )}
      </div>
    );
  }

  // disconnected or idle
  return null;
}
