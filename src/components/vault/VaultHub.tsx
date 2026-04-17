import { useState, useEffect, useCallback } from "react";
import { useVaultStore } from "../../stores/vaultStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useAuthStore } from "../../stores/authStore";
import { useAppIcon } from "../../hooks/useAppIcon";
import { invoke } from "../../lib/electron";
import { showContextMenu } from "../../utils/contextMenu";
import {
  AlertCircleIcon, CheckIcon, ChevronRightIcon, FingerprintIcon, FolderOpenIcon, LoaderIcon, LockIcon, PlusIcon, RefreshIcon, UsersIcon, WifiOffIcon
} from "../../lib/icons";

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
      const msg = typeof err === "string" ? err : "Failed to connect";
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
        className={`w-full rounded-xl border border-stroke-dim bg-panel/50 shadow-lg overflow-hidden ${
          hasContent ? "max-w-3xl" : "max-w-md"
        }`}
      >
        {/* Auto-connect error banner */}
        {autoConnectError && (
          <div className="flex items-center gap-2 px-5 py-3 bg-red-500/10 border-b border-red-500/20">
            <AlertCircleIcon
              size={16}
              className="text-red-400 flex-shrink-0"
            />
            <p className="text-sm text-red-300 flex-1">{autoConnectError}</p>
            <button
              onClick={handleRetryAutoConnect}
              className="flex items-center gap-1 px-2 py-1 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/20 rounded transition-colors"
            >
              <RefreshIcon size={12} />
              Retry
            </button>
          </div>
        )}

        <div className={`flex ${hasContent ? "min-h-[400px]" : ""}`}>
          {/* ── Left Panel: Branding + Actions ── */}
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
            <h1 className="text-2xl font-bold text-ink mb-1">Conduit</h1>
            <p className="text-sm text-ink-muted mb-8 text-center">
              Select a vault to get started
            </p>

            <div className="w-full space-y-2">
              <button
                onClick={handleNewVault}
                disabled={isLoading}
                className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm font-medium text-white bg-conduit-600 hover:bg-conduit-500 rounded-lg transition-colors disabled:opacity-50"
              >
                <PlusIcon size={16} />
                New Vault
              </button>
              <button
                onClick={handleOpenVault}
                disabled={isLoading}
                className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm font-medium text-ink-secondary border border-stroke-dim rounded-lg hover:bg-well transition-colors disabled:opacity-50"
              >
                <FolderOpenIcon size={16} />
                Open Vault File
              </button>
            </div>
          </div>

          {/* ── Divider + Right Panel ── */}
          {hasContent && (
            <>
              {/* Vertical divider */}
              <div className="w-px bg-stroke-dim my-6" />

              {/* Right Panel: Vault sections */}
              <div className="flex-1 py-5 px-5 overflow-y-auto flex flex-col justify-center gap-5">
                {/* Team Vaults Section */}
                {showTeamSection && (
                  <div>
                    <h2 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2 px-1 flex items-center gap-1.5">
                      <UsersIcon size={12} className="text-conduit-400" />
                      Team Vaults
                    </h2>
                    <div className="rounded-lg border border-stroke-dim overflow-hidden">
                      {teamLoading ? (
                        <div className="flex items-center justify-center gap-2 py-6 text-ink-muted">
                          <LoaderIcon size={16} className="animate-spin" />
                          <span className="text-sm">Loading...</span>
                        </div>
                      ) : teamVaults.length > 0 ? (
                        teamVaults.map((vault) => (
                          <button
                            key={vault.id}
                            onClick={() => handleTeamVault(vault)}
                            disabled={isOffline || isLoading}
                            className="group flex items-center gap-3 w-full text-left px-3.5 py-2.5 hover:bg-well transition-colors border-b border-stroke-dim last:border-b-0 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <div className="w-7 h-7 rounded-md bg-conduit-500/10 flex items-center justify-center flex-shrink-0">
                              <UsersIcon
                                size={14}
                                className="text-conduit-400"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-ink truncate">
                                {vault.name}
                              </div>
                              {vault.description && (
                                <div className="text-xs text-ink-muted truncate">
                                  {vault.description}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {isOffline && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 bg-amber-500/10 rounded">
                                  <WifiOffIcon size={10} />
                                  Offline
                                </span>
                              )}
                              <span className="text-[11px] text-ink-faint">
                                {vault.member_count}{" "}
                                {vault.member_count === 1
                                  ? "member"
                                  : "members"}
                              </span>
                              <ChevronRightIcon
                                size={14}
                                className="text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity"
                              />
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="px-4 py-5 text-center text-sm text-ink-muted">
                          No team vaults available
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Team Vaults upgrade card for non-team members */}
                {showTeamUpgrade && (
                  <div>
                    <h2 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider mb-2 px-1 flex items-center gap-1.5">
                      <UsersIcon size={12} className="text-conduit-400" />
                      Team Vaults
                    </h2>
                    <div className="flex rounded-lg border border-stroke-dim overflow-hidden">
                      {/* Left: feature list */}
                      <div className="flex-1 bg-well px-4 py-4">
                        <ul className="space-y-2">
                          {["Zero-knowledge sharing", "Concurrent vault access", "Folder permissions", "Audit log"].map((f) => (
                            <li key={f} className="flex items-center gap-2 text-xs text-ink-secondary">
                              <CheckIcon size={12} className="text-conduit-400 flex-shrink-0" />
                              {f}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {/* Right: CTA */}
                      <div className="flex-1 px-4 py-4 flex flex-col items-center justify-center">
                        <span className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-3">
                          Teams Plan
                        </span>
                        <button
                          onClick={() => invoke('auth_open_account')}
                          className="px-4 py-2 text-xs font-medium text-white bg-conduit-600 hover:bg-conduit-500 rounded-lg transition-colors"
                        >
                          Upgrade to Teams &rarr;
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Recent Vaults Section */}
                {hasRecentVaults && (
                  <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                      <h2 className="text-[11px] font-semibold text-ink-faint uppercase tracking-wider flex items-center gap-1.5">
                        <LockIcon size={12} className="text-ink-faint" />
                        Recent Vaults
                      </h2>
                      <button
                        onClick={() => clearRecentVaults()}
                        className="text-[11px] text-ink-faint hover:text-ink-muted transition-colors"
                      >
                        Clear All
                      </button>
                    </div>
                    <div className="rounded-lg border border-stroke-dim overflow-hidden">
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
                          <button
                            key={vaultPath}
                            onClick={() => handlePersonalVault(vaultPath)}
                            onContextMenu={(e) => handleRecentVaultContextMenu(e, vaultPath)}
                            disabled={isLoading}
                            className="group flex items-center gap-3 w-full text-left px-3.5 py-2.5 hover:bg-well transition-colors border-b border-stroke-dim last:border-b-0 disabled:opacity-50"
                            title={vaultPath}
                          >
                            <div className="w-7 h-7 rounded-md bg-raised flex items-center justify-center flex-shrink-0">
                              <FolderOpenIcon
                                size={14}
                                className="text-ink-muted"
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-ink truncate">
                                {fileName}
                              </div>
                              <div className="text-xs text-ink-faint truncate">
                                {dir}
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {biometricVaults.has(vaultPath) && (
                                <FingerprintIcon
                                  size={14}
                                  className="text-conduit-400"
                                />
                              )}
                              <ChevronRightIcon
                                size={14}
                                className="text-ink-faint opacity-0 group-hover:opacity-100 transition-opacity"
                              />
                            </div>
                          </button>
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
