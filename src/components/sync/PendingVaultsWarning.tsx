import { useState } from "react";
import { AlertTriangleIcon } from "../../lib/icons";
import { syncApi, errorText } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { isPendingPath } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { PendingVault } from "../../types/sync";
import { baseName } from "./sync-copy";

function nameOf(p: PendingVault): string {
  return (p.fileName ?? (p.sharedPath ? baseName(p.sharedPath) : "a vault")).replace(/\.conduit$/i, "");
}

/** VaultHub row badge: this vault has changes that exist only on this device. */
export function PendingBadge({ vaultPath }: { vaultPath: string }) {
  const pending = useSyncStore((s) => isPendingPath(s.state, vaultPath));
  if (!pending) return null;
  return (
    <span className="px-1.5 py-0.5 text-[10px] font-medium text-amber-400 bg-amber-500/10 rounded" title="Unlock this vault to sync them">
      Changes not yet synced
    </span>
  );
}

/** 5.11 start warning: sync is off but some vaults still hold changes that exist only here. */
export default function PendingVaultsWarning() {
  const state = useSyncStore((s) => s.state);
  const [busy, setBusy] = useState(false);
  if (!state || state.enabled || state.pendingVaults.length === 0) return null;

  const run = async (action: () => Promise<void>, failTitle: string) => {
    setBusy(true);
    try {
      await action();
      await useSyncStore.getState().refresh();
    } catch (err) {
      toast.error(failTitle, errorText(err, "Try again."));
    } finally {
      setBusy(false);
    }
  };
  const turnOn = () => run(async () => {
    await syncApi.setEnabled(true);
    toast.success("Multi-device sync is on.", "The changes sync the next time you unlock the vault.");
  }, "Could not turn sync on");
  const exportThem = () => run(async () => {
    for (const p of state.pendingVaults) {
      const { path } = await syncApi.exportUnsynced(p.lineageId);
      toast.info("Exported unsynced changes", baseName(path));
    }
  }, "Could not export");

  return (
    <div className="flex items-start gap-2 px-5 py-3 bg-amber-500/10 border-b border-amber-500/20">
      <AlertTriangleIcon size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 text-sm text-ink-secondary space-y-0.5">
        {state.pendingVaults.map((p) => (
          <p key={p.lineageId}>Changes to '{nameOf(p)}' exist only on this device.</p>
        ))}
      </div>
      <button type="button" disabled={busy} onClick={() => void turnOn()} className="px-2 py-1 text-xs text-white bg-conduit-600 hover:bg-conduit-500 rounded disabled:opacity-50">
        Turn sync back on
      </button>
      <button type="button" disabled={busy} onClick={() => void exportThem()} className="px-2 py-1 text-xs bg-well hover:bg-raised rounded disabled:opacity-50">
        Export them
      </button>
    </div>
  );
}
