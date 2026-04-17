import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { SettingsIcon } from "../../lib/icons";

function syncTooltip(status: string): string {
  switch (status) {
    case "synced":
      return "Synced";
    case "syncing":
      return "Syncing…";
    case "offline":
      return "Offline";
    case "error":
      return "Sync error";
    default:
      return "Idle";
  }
}

function syncDotClass(status: string): string {
  switch (status) {
    case "synced":
      return "bg-green-400";
    case "syncing":
      return "bg-green-400 animate-pulse";
    case "offline":
      return "bg-amber-400";
    case "error":
      return "bg-red-400";
    default:
      return "bg-ink-faint";
  }
}

export default function VaultContextBar() {
  const { vaultType, teamVaultId, teamSyncState } = useVaultStore();
  const { teamVaults } = useTeamStore();

  if (vaultType !== "team" || !teamVaultId) return null;

  const activeVault: TeamVaultSummary | undefined = teamVaults.find(
    (v) => v.id === teamVaultId
  );
  if (!activeVault) return null;

  const syncStatus = teamSyncState?.status ?? "idle";

  return (
    <div className="flex items-center justify-between px-3 py-1 border-b border-team-border border-l-2 border-l-team-border-strong bg-team">
      <div className="flex items-center gap-1.5">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${syncDotClass(syncStatus)}`}
          title={syncTooltip(syncStatus)}
        />
        <span className="text-[10px] text-ink-faint select-none">Team</span>
      </div>
      <button
        onClick={() =>
          document.dispatchEvent(
            new CustomEvent("conduit:vault-settings", {
              detail: { tab: "members" },
            })
          )
        }
        className="p-0.5 rounded hover:bg-conduit-500/10 text-ink-muted hover:text-conduit-400 transition-colors"
        title="Vault settings"
      >
        <SettingsIcon size={13} />
      </button>
    </div>
  );
}
