import { useState, useEffect, useCallback } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useAuthStore } from "../../stores/authStore";
import { useAppIcon } from "../../hooks/useAppIcon";
import { invoke } from "../../lib/electron";
import { showContextMenu } from "../../utils/contextMenu";
import PendingVaultsWarning, { PendingBadge } from "../sync/PendingVaultsWarning";
import { AlertCircleIcon, CheckIcon, FingerprintIcon } from "../../lib/icons";
import { Badge, Button, IconSlot, ListRow, Spinner, type IconSource } from "../ui";
import { errorText } from "../../lib/errorText";

/**
 * Full-screen vault landing page shown on launch and when returning from lock/close.
 * Split layout: left panel (branding + actions), right panel (vault lists by section).
 */
export default function VaultHub() {
  const { recentVaults, autoConnectError, isLoading, removeRecentVault, clearRecentVaults } = useVaultStore();
  const { teamVaults, isLoading: teamLoading } = useTeamStore();
  const { isTeamMember, authMode } = useAuthStore();

  const appIcon = useAppIcon();
  const isOffline = authMode === "cached";

  // Track which recent vaults have biometric enabled
  const [biometricVaults, setBiometricVaults] = useState<Set<string>>(new Set());
  const checkBiometricForVaults = useCallback(async () => {
    const result = new Set<string>();
    for (const vaultPath of recentVaults.slice(0, 5)) {
      try {
        const enabled = await invoke<boolean>("biometric_enabled_for_path", { vaultPath });
        if (enabled) result.add(vaultPath);
      } catch {
        // Ignore — biometric not available or IPC not registered
      }
    }
    setBiometricVaults(result);
  }, [recentVaults]);

  useEffect(() => {
    checkBiometricForVaults();
  }, [checkBiometricForVaults]);
  const isSignedIn = authMode === "authenticated" || authMode === "cached";
  const showTeamSection = isSignedIn && isTeamMember;
  const showTeamUpgrade = isSignedIn && !isTeamMember;

  const handleTeamVault = async (vault: TeamVaultSummary) => {
    if (isOffline) return;

    // Check identity key first
    try {
      const exists = await invoke<boolean>("identity_key_exists");
      if (!exists) {
        document.dispatchEvent(new CustomEvent("conduit:device-setup"));
        return;
      }
    } catch {
      document.dispatchEvent(new CustomEvent("conduit:device-setup"));
      return;
    }

    // Lock personal vault if currently unlocked
    const vaultState = useVaultStore.getState();
    if (vaultState.vaultType === "personal" && vaultState.isUnlocked) {
      await vaultState.lockVault();
    } else if (vaultState.vaultType === "team") {
      await vaultState.closeTeamVault();
    }

    // Show team vault unlock overlay
    document.dispatchEvent(
      new CustomEvent("conduit:team-vault-unlock", { detail: vault })
    );
  };

  const handlePersonalVault = async (vaultPath: string) => {
    // Close team vault if active
    const vaultState = useVaultStore.getState();
    if (vaultState.vaultType === "team") {
      await vaultState.closeTeamVault();
    }

    await vaultState.openVault(vaultPath);
    document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
  };

  const handleNewVault = () => {
    document.dispatchEvent(new CustomEvent("conduit:new-vault"));
  };

  const handleOpenVault = () => {
    document.dispatchEvent(new CustomEvent("conduit:open-vault"));
  };

  const handleRetryAutoConnect = async () => {
    const vaultState = useVaultStore.getState();
    vaultState.setAutoConnectError(null);

    try {
      const settings = await invoke<{
        last_vault_type?: string;
        last_team_vault_id?: string | null;
      }>("settings_get");

      if (settings.last_vault_type === "team" && settings.last_team_vault_id) {
        vaultState.setAutoConnectInProgress(true);
        vaultState.setShowVaultHub(false);
        await vaultState.openTeamVault(settings.last_team_vault_id);
        vaultState.setAutoConnectInProgress(false);
        vaultState.setShowVaultHub(false);
      }
    } catch (err) {
      const msg = errorText(err, "Failed to connect");
      vaultState.setAutoConnectInProgress(false);
      vaultState.setAutoConnectError(msg);
      vaultState.setShowVaultHub(true);
    }
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
      await removeRecentVault(vaultPath);
    } else if (selected === "copy") {
      await navigator.clipboard.writeText(vaultPath);
    }
  };

  const hasTeamVaults = showTeamSection && teamVaults.length > 0;
  const hasRecentVaults = recentVaults.length > 0;
  const hasContent = hasTeamVaults || hasRecentVaults || showTeamUpgrade;

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div
        className={`w-full rounded-lg border border-card-border bg-sidebar overflow-hidden ${
          hasContent ? "max-w-3xl" : "max-w-md"
        }`}
      >
        {autoConnectError && (
          <div className="flex items-center gap-2 px-5 py-3 bg-danger-bg border-b border-danger-border">
            <AlertCircleIcon size={16} className="text-danger flex-shrink-0" />
            <p className="text-body text-danger flex-1">{autoConnectError}</p>
            <Button size="sm" icon="refresh" onClick={handleRetryAutoConnect}>
              Retry
            </Button>
          </div>
        )}

        <PendingVaultsWarning />

        <div className={`flex ${hasContent ? "min-h-[400px]" : ""}`}>
          <div
            className={`flex flex-col items-center justify-center p-8 ${
              hasContent ? "w-[260px] flex-shrink-0" : "w-full"
            }`}
          >
            <img
              src={appIcon}
              alt="Conduit"
              className="w-20 h-20 mb-5 rounded-2xl"
              draggable={false}
            />
            <h1 className="text-display text-ink mb-1">Conduit</h1>
            <p className="text-body text-ink-muted mb-8 text-center">
              Select a vault to get started
            </p>

            <div className="w-full space-y-2">
              <Button size="lg" variant="primary" icon="plus" fullWidth onClick={handleNewVault} disabled={isLoading}>
                New Vault
              </Button>
              <Button size="lg" variant="secondary" icon="folderOpen" fullWidth onClick={handleOpenVault} disabled={isLoading}>
                Open Vault File
              </Button>
            </div>
          </div>

          {hasContent && (
            <>
              <div className="w-px bg-divider my-6" />

              <div className="flex-1 min-w-0 py-5 px-5 overflow-y-auto flex flex-col justify-center gap-5">
                {showTeamSection && (
                  <div>
                    <SectionTitle icon="users" iconClassName="text-info">Team Vaults</SectionTitle>
                    <div className="rounded-md border border-card-border p-1">
                      {teamLoading ? (
                        <div className="flex items-center justify-center py-6 text-body text-ink-muted">
                          <Spinner size={16} text="Loading..." />
                        </div>
                      ) : teamVaults.length > 0 ? (
                        teamVaults.map((vault) => (
                          <ListRow
                            key={vault.id}
                            onClick={() => handleTeamVault(vault)}
                            disabled={isOffline || isLoading}
                            leading={<RowTile icon="users" className="bg-info-bg text-info" />}
                            description={vault.description || undefined}
                            meta={
                              <>
                                {isOffline && (
                                  <Badge tone="warning" icon="wifiOff">
                                    Offline
                                  </Badge>
                                )}
                                <span>
                                  {vault.member_count} {vault.member_count === 1 ? "member" : "members"}
                                </span>
                              </>
                            }
                            trailing={<RowChevron />}
                          >
                            <span className="text-ink">{vault.name}</span>
                          </ListRow>
                        ))
                      ) : (
                        <div className="px-4 py-5 text-center text-body text-ink-muted">
                          No team vaults available
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {showTeamUpgrade && (
                  <div>
                    <SectionTitle icon="users" iconClassName="text-info">Team Vaults</SectionTitle>
                    <div className="flex rounded-md border border-card-border overflow-hidden">
                      <div className="flex-1 bg-well px-4 py-4">
                        <ul className="space-y-2">
                          {["Shared vaults for your team", "Zero-knowledge sharing", "Folder permissions", "Audit log"].map((f) => (
                            <li key={f} className="flex items-center gap-2 text-label text-ink-secondary">
                              <CheckIcon size={12} className="text-info flex-shrink-0" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="flex-1 px-4 py-4 flex flex-col items-center justify-center">
                        <span className="text-meta font-semibold text-ink-muted mb-3">
                          Teams Plan
                        </span>
                        <Button variant="primary" onClick={() => invoke('auth_open_account')}>
                          Upgrade to Teams &rarr;
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {hasRecentVaults && (
                  <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <SectionTitle icon="lock" className="">Recent Vaults</SectionTitle>
                      <Button variant="link" size="sm" onClick={() => clearRecentVaults()}>
                        Clear All
                      </Button>
                    </div>
                    <div className="rounded-md border border-card-border p-1">
                      {recentVaults.slice(0, 5).map((vaultPath) => {
                        const fileName =
                          vaultPath
                            .split(/[/\\]/)
                            .pop()
                            ?.replace(".conduit", "") ?? vaultPath;
                        const parts = vaultPath.split(/[/\\]/);
                        const dir =
                          parts.length > 1
                            ? parts.slice(0, -1).join("/")
                            : "";
                        return (
                          <ListRow
                            key={vaultPath}
                            onClick={() => handlePersonalVault(vaultPath)}
                            onContextMenu={(e) => handleRecentVaultContextMenu(e, vaultPath)}
                            disabled={isLoading}
                            title={vaultPath}
                            leading={<RowTile icon="folderOpen" className="bg-well text-ink-muted" />}
                            description={dir}
                            meta={
                              <>
                                <PendingBadge vaultPath={vaultPath} />
                                {biometricVaults.has(vaultPath) && <FingerprintIcon size={16} className="text-info" />}
                              </>
                            }
                            trailing={<RowChevron />}
                          >
                            <span className="text-ink">{fileName}</span>
                          </ListRow>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({
  icon,
  iconClassName = "text-ink-muted",
  className = "mb-2 px-1",
  children,
}: {
  icon: IconSource;
  iconClassName?: string;
  className?: string;
  children: string;
}) {
  return (
    <h2 className={`flex items-center gap-1.5 text-meta font-semibold text-ink-muted ${className}`}>
      <IconSlot icon={icon} size={12} compact className={iconClassName} />
      {children}
    </h2>
  );
}

/** The 28px icon tile a hub row leads with (spec 3.11). */
function RowTile({ icon, className }: { icon: IconSource; className: string }) {
  return (
    <span className={`flex size-7 items-center justify-center rounded-md ${className}`}>
      <IconSlot icon={icon} />
    </span>
  );
}

function RowChevron() {
  return <IconSlot icon="chevronRight" className="text-ink-faint" />;
}
