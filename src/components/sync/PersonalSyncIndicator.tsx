import { AlertTriangleIcon, CloudOffIcon, DevicesIcon, LoaderIcon, WifiOffIcon } from "../../lib/icons";
import type { IconComponent } from "../../lib/icons";
import { useSyncStore } from "../../stores/syncStore";
import { useVaultStore } from "../../stores/vaultStore";
import { activeStatus } from "../../stores/sync-reducers";
import type { SyncStatus } from "../../types/sync";
import { statusDetail, statusLabel, statusTone, type StatusTone } from "./sync-copy";

const TONE_CLASS: Readonly<Record<StatusTone, string>> = {
  ok: "text-success",
  busy: "text-link",
  warn: "text-warning",
  error: "text-danger",
  off: "text-ink-faint",
};

function iconFor(status: SyncStatus, killSwitch: boolean): IconComponent {
  if (killSwitch) return CloudOffIcon;
  if (status.kind === "offline") return WifiOffIcon;
  if (status.kind === "syncing" || status.kind === "waiting") return LoaderIcon;
  if (status.kind === "up-to-date") return DevicesIcon;
  return AlertTriangleIcon;
}

function openSyncSettings(): void {
  document.dispatchEvent(new CustomEvent("conduit:settings", { detail: { tab: "sync" } }));
}

/** Sidebar status of personal-vault sync: Up to date, Syncing, Waiting, Paused, "3 to review". */
export default function PersonalSyncIndicator() {
  const vaultType = useVaultStore((s) => s.vaultType);
  const state = useSyncStore((s) => s.state);
  const status = activeStatus(state);
  if (vaultType !== "personal" || state === null || status === null) return null;

  const killSwitch = state.killSwitch;
  const Icon = iconFor(status, killSwitch);
  const label = statusLabel(status, killSwitch);
  const detail = statusDetail(status);
  const spinning = Icon === LoaderIcon;
  const review = status.conflictCount;

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={openSyncSettings}
        className={`inline-flex size-toolbar shrink-0 items-center justify-center rounded hover:bg-toolbar-hover ${TONE_CLASS[statusTone(status, killSwitch)]}`}
        title={detail ? `${label}. ${detail}` : label}
        aria-label={`Sync: ${label}`}
      >
        <Icon size={16} className={spinning ? "animate-spin" : undefined} />
      </button>
      {review > 0 && (
        <button
          type="button"
          onClick={() => useSyncStore.getState().openView({ kind: "review", row: null })}
          data-cv-review-button
          className="h-5 shrink-0 rounded px-1.5 text-badge font-semibold text-warning bg-warning-bg hover:underline"
          title="Review changes from your other devices"
        >
          {review} to review
        </button>
      )}
    </div>
  );
}
