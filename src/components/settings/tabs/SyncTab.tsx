import { useEffect, useState, type ReactNode } from "react";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useTierStore } from "../../../stores/tierStore";
import { activeStatus } from "../../../stores/sync-reducers";
import { errorText } from "../../../lib/sync-api";
import { toast } from "../../common/Toast";
import SyncDevicesList from "../../sync/SyncDevicesList";
import SyncNoticeList from "../../sync/SyncNoticeList";
import { smallButton } from "../../sync/ConflictFieldRow";
import { deviceLimitText, statusDetail, statusLabel } from "../../sync/sync-copy";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink mb-3">{title}</h3>
      {children}
    </div>
  );
}

function StatusBlock() {
  const state = useSyncStore((s) => s.state);
  const status = activeStatus(state);
  const [syncing, setSyncing] = useState(false);
  if (state === null || status === null) {
    const shared = state?.vault?.shared === true;
    return (
      <p className="text-sm text-ink-muted">
        {shared ? "Sync is off for this vault until the next unlock." : "Unlock a vault stored in a synced folder to see its sync status."}
      </p>
    );
  }
  const syncNow = async () => {
    setSyncing(true);
    try {
      await useSyncStore.getState().syncNow();
    } catch (err) {
      toast.error("Could not sync", errorText(err, "Try again."));
    } finally {
      setSyncing(false);
    }
  };
  const open = useSyncStore.getState().openView;
  const detail = statusDetail(status);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-3 rounded-lg bg-well border border-stroke-dim">
        <div>
          <p className="text-sm font-medium text-ink">{statusLabel(status, state.killSwitch)}</p>
          {detail && <p className="text-xs text-ink-muted mt-0.5">{detail}</p>}
        </div>
        <button type="button" disabled={syncing} onClick={() => void syncNow()} className={smallButton(true)}>
          {syncing ? "Syncing..." : "Sync now"}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => open({ kind: "review", row: null })} className={smallButton()}>
          Review changes{status.conflictCount > 0 ? ` (${status.conflictCount})` : ""}
        </button>
        <button type="button" onClick={() => open({ kind: "recently-deleted" })} className={smallButton()}>Recently deleted</button>
        <button type="button" onClick={() => open({ kind: "other-copies" })} className={smallButton()}>Other copies</button>
      </div>
      <SyncNoticeList />
    </div>
  );
}

/** Settings > Sync: plan limit, status, devices and review tools. Sync itself has no on/off switch. */
export default function SyncTab() {
  const vaultType = useVaultStore((s) => s.vaultType);
  const stateLimit = useSyncStore((s) => s.state?.deviceLimit ?? null);
  const tierLimit = useTierStore((s) => s.maxOpenDevices);
  const engineRunning = useSyncStore((s) => activeStatus(s.state) !== null);
  const killSwitch = useSyncStore((s) => s.state?.killSwitch ?? false);

  useEffect(() => {
    void useSyncStore.getState().refresh();
  }, []);

  return (
    <div className="space-y-6">
      <Section title="Multi-device sync">
        <p className="text-sm text-ink-muted px-1">
          Conduit merges changes from every device that opens a vault file in a synced folder.
        </p>
        <p className="text-xs text-ink-muted mt-2 px-1">
          Your plan: a vault can be open {deviceLimitText(stateLimit ?? tierLimit)}
          {stateLimit?.source === "dev-override" ? " (dev override)" : ""}. Team vaults sync through your team.
        </p>
        {killSwitch && <p className="text-xs text-amber-400 mt-2 px-1">Conduit paused syncing for now. Your changes are saved on this device.</p>}
      </Section>
      {vaultType === "personal" && (
        <Section title="This vault">
          <StatusBlock />
        </Section>
      )}
      {vaultType === "personal" && engineRunning && (
        <Section title="Devices">
          <SyncDevicesList />
        </Section>
      )}
    </div>
  );
}
