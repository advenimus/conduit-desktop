import { useVaultStore } from "../../stores/vaultStore";
import { AlertTriangleIcon, CloudIcon, CloudOffIcon } from "../../lib/icons";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();

  if (diffMs < 60_000) return "just now";
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Reads vaultStore.cloudSyncState, which useBackupStates keeps current. */
export default function CloudSyncIndicator() {
  const cloudSyncState = useVaultStore((s) => s.cloudSyncState);

  if (!cloudSyncState || cloudSyncState.status === "disabled") {
    return null;
  }

  const { status, lastSyncedAt, error } = cloudSyncState;

  if (status === "synced") {
    return (
      <div
        className="flex size-toolbar shrink-0 items-center justify-center text-success"
        title={`Cloud synced${lastSyncedAt ? `: ${formatTime(lastSyncedAt)}` : ""}`}
      >
        <CloudIcon size={16} />
      </div>
    );
  }

  if (status === "syncing") {
    return (
      <div className="flex size-toolbar shrink-0 items-center justify-center text-info animate-pulse" title="Syncing...">
        <CloudIcon size={16} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        className="flex size-toolbar shrink-0 items-center justify-center text-warning"
        title={`Sync error: ${error ?? "Unknown error"}`}
      >
        <AlertTriangleIcon size={16} />
      </div>
    );
  }

  // idle
  return (
    <div className="flex size-toolbar shrink-0 items-center justify-center text-ink-faint" title="Cloud backup enabled">
      <CloudOffIcon size={16} />
    </div>
  );
}
