import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useAuthStore } from "../../stores/authStore";
import { useEntryStore } from "../../stores/entryStore";
import { invoke } from "../../lib/electron";
import { showContextMenu } from "../../utils/contextMenu";
import {
  ArrowsExchangeIcon, CheckIcon, ChevronRightIcon, FolderOpenIcon, LockIcon, NetworkIcon, PlusIcon, UsersIcon
} from "../../lib/icons";

interface VaultSwitcherMenuProps {
  onClose: () => void;
  onNeedDeviceSetup: () => void;
  onTeamVaultUnlock: (vault: TeamVaultSummary) => void;
}

export default function VaultSwitcherMenu({
  onClose,
  onNeedDeviceSetup,
  onTeamVaultUnlock,
}: VaultSwitcherMenuProps) {
  const { isUnlocked, currentVaultPath, recentVaults, vaultType, teamVaultId, isNetworkVault } =
    useVaultStore();
  const { teamVaults, myRole, team } = useTeamStore();
  const { isTeamMember, authMode } = useAuthStore();

  const otherVaults = recentVaults
    .filter((p) => p !== currentVaultPath)
    .slice(0, 5);

  const handlePersonalVault = async (vaultPath: string) => {
    onClose();
    // If currently in a team vault, close it first
    if (vaultType === "team") {
      await useVaultStore.getState().closeTeamVault();
    }
    await useVaultStore.getState().openVault(vaultPath);
    document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
  };

  const handleTeamVault = async (vault: TeamVaultSummary) => {
    onClose();
    // Check identity key first
    try {
      const exists = await invoke<boolean>("identity_key_exists");
      if (!exists) {
        onNeedDeviceSetup();
        return;
      }
    } catch {
      onNeedDeviceSetup();
      return;
    }

    // Lock personal vault if unlocked
    if (vaultType === "personal" && isUnlocked) {
      await useVaultStore.getState().lockVault();
    } else if (vaultType === "team") {
      await useVaultStore.getState().closeTeamVault();
    }

    onTeamVaultUnlock(vault);
  };

  const handleNewVault = () => {
    onClose();
    document.dispatchEvent(new CustomEvent("conduit:new-vault"));
  };

  const handleOpenVault = () => {
    onClose();
    document.dispatchEvent(new CustomEvent("conduit:open-vault"));
  };

  const handleCreateTeamVault = () => {
    onClose();
    document.dispatchEvent(new CustomEvent("conduit:create-team-vault"));
  };

  const handleLock = async () => {
    onClose();
    if (vaultType === "team") {
      await useVaultStore.getState().closeTeamVault();
    } else {
      await useVaultStore.getState().lockVault();
    }
    useEntryStore.setState({ entries: [], folders: [] });
    const { useAiStore } = await import("../../stores/aiStore");
    useAiStore.getState().resetConversationState();
  };

  const handleRecentVaultContextMenu = async (e: React.MouseEvent, vaultPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    const selected = await showContextMenu(e.clientX, e.clientY, [
      { id: "remove", label: "Remove from Recents", icon: "close" },
      { id: "sep", label: "", type: "separator" },
      { id: "copy", label: "Copy Path", icon: "copy" },
    ]);
    if (selected === "remove") {
      await useVaultStore.getState().removeRecentVault(vaultPath);
    } else if (selected === "copy") {
      await navigator.clipboard.writeText(vaultPath);
    }
  };

  const isPersonalActive = vaultType === "personal";
  const isSignedIn = authMode === "authenticated" || authMode === "cached";

  return (
    <div data-context-menu className="absolute top-full left-0 mt-1 w-[280px] bg-panel rounded-lg shadow-lg border border-stroke-dim z-50 py-1 overflow-hidden">
      {/* Personal Vaults */}
      <div className="px-3 py-1.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wider">
        Personal Vaults
      </div>

      {/* Current vault */}
      {currentVaultPath && (
        <button
          onClick={() => {
            if (vaultType === "team") {
              handlePersonalVault(currentVaultPath);
            } else {
              onClose();
            }
          }}
          className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm hover:bg-well rounded-sm mx-0"
        >
          <span
            className={`w-5 flex items-center justify-center ${
              isPersonalActive ? "text-conduit-400" : "text-transparent"
            }`}
          >
            <CheckIcon size={14} />
          </span>
          <span className={`truncate ${isPersonalActive ? "text-ink font-medium" : "text-ink-secondary"}`}>
            {currentVaultPath.split(/[/\\]/).pop()?.replace(".conduit", "") ?? "Vault"}
          </span>
          {isNetworkVault && isPersonalActive && (
            <span title="Network vault"><NetworkIcon size={12} className="text-ink-faint flex-shrink-0" /></span>
          )}
        </button>
      )}

      {/* Recent vaults */}
      {otherVaults.map((vaultPath) => {
        const fileName =
          vaultPath.split(/[/\\]/).pop()?.replace(".conduit", "") ?? vaultPath;
        return (
          <button
            key={vaultPath}
            onClick={() => handlePersonalVault(vaultPath)}
            onContextMenu={(e) => handleRecentVaultContextMenu(e, vaultPath)}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-secondary hover:bg-well rounded-sm mx-0"
            title={vaultPath}
          >
            <span className="w-5" />
            <span className="truncate">{fileName}</span>
          </button>
        );
      })}

      {/* New / Open vault */}
      <button
        onClick={handleNewVault}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-muted hover:bg-well hover:text-ink rounded-sm mx-0"
      >
        <span className="w-5 flex items-center justify-center">
          <PlusIcon size={14} />
        </span>
        New Vault...
      </button>
      <button
        onClick={handleOpenVault}
        className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-muted hover:bg-well hover:text-ink rounded-sm mx-0"
      >
        <span className="w-5 flex items-center justify-center">
          <FolderOpenIcon size={14} />
        </span>
        Open Vault File...
      </button>

      {/* Team Vaults section */}
      {isSignedIn && (
        <>
          <div className="border-t border-stroke-dim my-1" />
          <div className="px-3 py-1.5 text-[10px] font-semibold text-ink-faint uppercase tracking-wider">
            Team Vaults
          </div>

          {isTeamMember && team ? (
            <>
              {teamVaults.length > 0 ? (
                teamVaults.map((vault) => {
                  const isActive =
                    vaultType === "team" && teamVaultId === vault.id;
                  return (
                    <button
                      key={vault.id}
                      onClick={() => {
                        if (isActive) {
                          onClose();
                        } else {
                          handleTeamVault(vault);
                        }
                      }}
                      className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm hover:bg-well rounded-sm mx-0"
                      title={vault.description ?? vault.name}
                    >
                      <span
                        className={`w-5 flex items-center justify-center ${
                          isActive ? "text-conduit-400" : "text-transparent"
                        }`}
                      >
                        <CheckIcon size={14} />
                      </span>
                      <UsersIcon
                        size={14}
                        className="text-conduit-400 flex-shrink-0"
                      />
                      <span
                        className={`truncate flex-1 ${isActive ? "text-ink font-medium" : "text-ink-secondary"}`}
                      >
                        {vault.name}
                      </span>
                      <span className="text-[10px] text-ink-faint flex-shrink-0">
                        {vault.member_count}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="px-3 py-2 text-xs text-ink-faint leading-relaxed">
                  No team vaults yet.{" "}
                  {myRole === "admin"
                    ? "Create a shared vault for your team."
                    : "A team admin can create shared vaults for your team."}
                </div>
              )}

              {myRole === "admin" && (
                <button
                  onClick={handleCreateTeamVault}
                  className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-muted hover:bg-well hover:text-ink rounded-sm mx-0"
                >
                  <span className="w-5 flex items-center justify-center">
                    <PlusIcon size={14} />
                  </span>
                  Create Team Vault...
                </button>
              )}
            </>
          ) : (
            <button
              onClick={() => {
                onClose();
                invoke('auth_open_account');
              }}
              className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-muted hover:bg-well hover:text-ink rounded-sm mx-0"
            >
              <span className="w-5 flex items-center justify-center">
                <UsersIcon size={14} className="text-ink-faint" />
              </span>
              <span className="text-xs flex-1">Upgrade to Teams for shared vaults</span>
              <ChevronRightIcon size={12} className="text-ink-faint" />
            </button>
          )}
        </>
      )}

      {/* Lock & Switch */}
      {isUnlocked && (
        <>
          <div className="border-t border-stroke-dim my-1" />
          <button
            onClick={handleLock}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-muted hover:bg-well hover:text-ink rounded-sm mx-0"
          >
            <span className="w-5 flex items-center justify-center">
              <LockIcon size={14} />
            </span>
            Lock Current Vault
          </button>
          <button
            onClick={handleLock}
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-sm text-ink-muted hover:bg-well hover:text-ink rounded-sm mx-0"
          >
            <span className="w-5 flex items-center justify-center">
              <ArrowsExchangeIcon size={14} />
            </span>
            Switch Vault...
          </button>
        </>
      )}
    </div>
  );
}
