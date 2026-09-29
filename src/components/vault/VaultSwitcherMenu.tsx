import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useAuthStore } from "../../stores/authStore";
import { useEntryStore } from "../../stores/entryStore";
import { invoke } from "../../lib/electron";
import type { ComponentPropsWithRef, ReactNode } from "react";
import {
  ArrowsExchangeIcon, CheckIcon, ChevronRightIcon, FolderOpenIcon, LockIcon, LockOpenIcon, NetworkIcon, PlusIcon, UsersIcon
} from "../../lib/icons";
import { useStartupVaultStore } from "../../stores/startupVaultStore";
import { INDICATOR_TEXT } from "../../lib/startup-vault-copy";
import { openRecentVaultMenu, openTeamVaultMenu } from "./recentVaultMenu";
import { Menu, MenuHeader, MenuSeparator, cx } from "../ui";

interface VaultMenuRowProps extends ComponentPropsWithRef<"button"> {
  /** The 16px leading slot: the current vault's check, or the row's icon. Empty keeps the names aligned. */
  lead?: ReactNode;
}

/** A row with the DOM menu item look (spec 3.6, 4.10); rows stay buttons because the harness clicks them by text (B43). */
function VaultMenuRow({ lead, className, children, onMouseEnter, ...rest }: VaultMenuRowProps) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        e.currentTarget.focus();
      }}
      className={cx(
        "mx-1 flex h-6 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 text-left text-body text-ink-secondary",
        "focus:bg-(--c-menu-selection-bg) focus:outline focus:outline-1 focus:-outline-offset-1 focus:outline-(--c-menu-selection-border)",
        className,
      )}
      {...rest}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-ink-muted">{lead}</span>
      {children}
    </button>
  );
}

const currentMark = <CheckIcon size={16} className="text-ink-secondary" />;

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
  const autoUnlockOn = useStartupVaultStore((s) => s.status?.currentOn ?? false);

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


  const isPersonalActive = vaultType === "personal";
  const isSignedIn = authMode === "authenticated" || authMode === "cached";

  return (
    <Menu
      data-context-menu
      autoFocus={false}
      className="absolute top-full left-0 z-50 mt-1 w-[280px] overflow-hidden rounded-lg border border-overlay-border bg-overlay shadow-overlay"
    >
      <MenuHeader>Personal Vaults</MenuHeader>

      {/* Current vault */}
      {currentVaultPath && (
        <VaultMenuRow
          lead={isPersonalActive ? currentMark : null}
          onContextMenu={(e) => void openRecentVaultMenu(e, currentVaultPath)}
          onClick={() => {
            if (vaultType === "team") {
              handlePersonalVault(currentVaultPath);
            } else {
              onClose();
            }
          }}
        >
          <span className={cx("min-w-0 truncate", isPersonalActive && "font-semibold text-ink")}>
            {currentVaultPath.split(/[/\\]/).pop()?.replace(".conduit", "") ?? "Vault"}
          </span>
          {isNetworkVault && isPersonalActive && (
            <span title="Network vault"><NetworkIcon size={12} className="text-ink-faint flex-shrink-0" /></span>
          )}
          {autoUnlockOn && isPersonalActive && (
            <span title={INDICATOR_TEXT} className="inline-flex">
              <LockOpenIcon size={12} className="text-ink-faint flex-shrink-0" />
              <span className="sr-only">{INDICATOR_TEXT}</span>
            </span>
          )}
        </VaultMenuRow>
      )}

      {/* Recent vaults */}
      {otherVaults.map((vaultPath) => {
        const fileName =
          vaultPath.split(/[/\\]/).pop()?.replace(".conduit", "") ?? vaultPath;
        return (
          <VaultMenuRow
            key={vaultPath}
            onClick={() => handlePersonalVault(vaultPath)}
            onContextMenu={(e) => void openRecentVaultMenu(e, vaultPath)}
            title={vaultPath}
          >
            <span className="min-w-0 truncate">{fileName}</span>
          </VaultMenuRow>
        );
      })}

      {/* New / Open vault */}
      <VaultMenuRow lead={<PlusIcon size={16} />} onClick={handleNewVault}>
        New Vault...
      </VaultMenuRow>
      <VaultMenuRow lead={<FolderOpenIcon size={16} />} onClick={handleOpenVault}>
        Open Vault File...
      </VaultMenuRow>

      {/* Team Vaults section */}
      {isSignedIn && (
        <>
          <MenuSeparator />
          <MenuHeader>Team Vaults</MenuHeader>

          {isTeamMember && team ? (
            <>
              {teamVaults.length > 0 ? (
                teamVaults.map((vault) => {
                  const isActive =
                    vaultType === "team" && teamVaultId === vault.id;
                  return (
                    <VaultMenuRow
                      key={vault.id}
                      lead={isActive ? currentMark : null}
                      onContextMenu={(e) => void openTeamVaultMenu(e, vault)}
                      onClick={() => {
                        if (isActive) {
                          onClose();
                        } else {
                          handleTeamVault(vault);
                        }
                      }}
                      title={vault.description ?? vault.name}
                    >
                      <UsersIcon size={16} className="text-ink-muted flex-shrink-0" />
                      <span className={cx("min-w-0 flex-1 truncate", isActive && "font-semibold text-ink")}>
                        {vault.name}
                      </span>
                      <span className="text-badge text-ink-faint tabular-nums flex-shrink-0">
                        {vault.member_count}
                      </span>
                    </VaultMenuRow>
                  );
                })
              ) : (
                <div className="px-3 py-1.5 text-label text-ink-muted">
                  No team vaults yet.{" "}
                  {myRole === "admin"
                    ? "Create a shared vault for your team."
                    : "A team admin can create shared vaults for your team."}
                </div>
              )}

              {myRole === "admin" && (
                <VaultMenuRow lead={<PlusIcon size={16} />} onClick={handleCreateTeamVault}>
                  Create Team Vault...
                </VaultMenuRow>
              )}
            </>
          ) : (
            <VaultMenuRow
              lead={<UsersIcon size={16} />}
              onClick={() => {
                onClose();
                invoke('auth_open_account');
              }}
            >
              <span className="min-w-0 flex-1 truncate text-label">Upgrade to Teams for shared vaults</span>
              <ChevronRightIcon size={12} className="text-ink-faint flex-shrink-0" />
            </VaultMenuRow>
          )}
        </>
      )}

      {/* Lock & Switch */}
      {isUnlocked && (
        <>
          <MenuSeparator />
          <VaultMenuRow lead={<LockIcon size={16} />} onClick={handleLock}>
            Lock Current Vault
          </VaultMenuRow>
          <VaultMenuRow lead={<ArrowsExchangeIcon size={16} />} onClick={handleLock}>
            Switch Vault...
          </VaultMenuRow>
        </>
      )}
    </Menu>
  );
}
