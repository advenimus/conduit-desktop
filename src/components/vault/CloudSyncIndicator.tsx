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
        className="p-1 text-green-400"
        title={`Cloud synced${lastSyncedAt ? `: ${formatTime(lastSyncedAt)}` : ""}`}
      >
        <CloudIcon size={14} />
      </div>
    );
  }

  if (status === "syncing") {
    return (
      <div className="p-1 text-conduit-400 animate-pulse" title="Syncing...">
        <CloudIcon size={14} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div
        className="p-1 text-amber-400"
        title={`Sync error: ${error ?? "Unknown error"}`}
      >
        <AlertTriangleIcon size={14} />
      </div>
    );
  }

  // idle
  return (
    <div className="p-1 text-ink-faint" title="Cloud backup enabled">
      <CloudOffIcon size={14} />
    </div>
  );
}
