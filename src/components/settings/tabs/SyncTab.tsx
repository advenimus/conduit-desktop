import { useEffect, useState, type ReactNode } from "react";
import { useSyncStore } from "../../../stores/syncStore";
import { useVaultStore } from "../../../stores/vaultStore";
import { useTierStore } from "../../../stores/tierStore";
import { useAuthStore } from "../../../stores/authStore";
import { activeStatus } from "../../../stores/sync-reducers";
import { errorText } from "../../../lib/errorText";
import { toast } from "../../common/Toast";
import SyncDevicesList from "../../sync/SyncDevicesList";
import SyncNoticeList from "../../sync/SyncNoticeList";
import { Button, Card, SectionHeader } from "../../ui";
import { HINT } from "../settings-styles";
import { deviceCapText, deviceLimitText, ownerLineText, releaseAfterText, statusDetail, statusLabel } from "../../sync/sync-copy";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <SectionHeader title={title} />
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
      <p className="text-body text-ink-muted">
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
      <Card data-cv-sync-status="" className="flex items-center justify-between gap-4">
        <div>
          <p data-cv-sync-status-label="" className="text-body font-semibold text-ink">{statusLabel(status, state.killSwitch)}</p>
          {detail && <p data-cv-sync-status-detail="" className={`mt-0.5 ${HINT}`}>{detail}</p>}
        </div>
        <Button variant="primary" size="sm" loading={syncing} loadingLabel="Syncing..." onClick={() => void syncNow()}>
          Sync now
        </Button>
      </Card>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => open({ kind: "review", row: null })}>
          Review changes{status.conflictCount > 0 ? ` (${status.conflictCount})` : ""}
        </Button>
        <Button size="sm" onClick={() => open({ kind: "recently-deleted" })}>Recently deleted</Button>
        <Button size="sm" onClick={() => open({ kind: "other-copies" })}>Other copies</Button>
      </div>
      <SyncNoticeList />
    </div>
  );
}

/** S11 owner line; the owner (signed in) gets [Release this vault...] (S12), disabled during the cooldown. */
function OwnerBlock() {
  const ownership = useSyncStore((s) => s.state?.ownership ?? null);
  const signedIn = useAuthStore((s) => s.isAuthenticated);
  const line = ownerLineText(ownership);
  if (line === null) return null;
  const owner = ownership?.kind === "owner" ? ownership : null;
  const tooSoon = owner !== null && owner.releaseAfterMs !== null && owner.releaseAfterMs > Date.now();
  return (
    <div data-cv-sync-owner={ownership?.kind ?? ""} className="mb-3 space-y-1 px-1">
      <p data-cv-sync-owner-line="" className="text-body text-ink">{line}</p>
      {owner !== null && signedIn && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={tooSoon} onClick={() => useSyncStore.getState().setReleaseDialogOpen(true)}>
            Release this vault...
          </Button>
          {tooSoon && owner.releaseAfterMs !== null && <span className={HINT}>{releaseAfterText(owner.releaseAfterMs)}</span>}
        </div>
      )}
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
  const stateCap = useSyncStore((s) => s.state?.deviceCap ?? null);
  const tierCap = useTierStore((s) => s.accountMaxActiveDevices);
  const capText = deviceCapText(stateCap ?? tierCap);

  useEffect(() => {
    void useSyncStore.getState().refresh();
  }, []);

  return (
    <div className="space-y-6">
      <Section title="Multi-device sync">
        <p className="px-1 text-body text-ink-muted">
          Conduit merges changes from every device that opens a vault file in a synced folder.
        </p>
        <p data-cv-sync-plan="" className={`mt-2 px-1 ${HINT}`}>
          Your plan: a vault can be open {deviceLimitText(stateLimit ?? tierLimit)}
          {stateLimit?.source === "dev-override" ? " (dev override)" : ""}. Team vaults sync through your team.
          {capText && ` ${capText}`}
        </p>
        {killSwitch && <p data-cv-sync-paused="" className="mt-2 px-1 text-meta text-warning">Conduit paused syncing for now. Your changes are saved on this device.</p>}
      </Section>
      {vaultType === "personal" && (
        <Section title="This vault">
          <OwnerBlock />
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
