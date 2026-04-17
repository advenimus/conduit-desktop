import { useState, useEffect, useRef, useCallback } from "react";
import {
  SettingsIcon,
  PlusIcon,
  FolderPlusIcon,
  SearchIcon,
  ChevronDownIcon,
  LoginIcon,
  LogoutIcon,
  StarIcon,
  StarFilledIcon,
  UsersIcon,
  CloseIcon,
  SparklesIcon,
  ClockIcon,
  HomeIcon,
} from "../../lib/icons";
import EntryTree from "../entries/EntryTree";
import { TeamInvitationBanner } from "./TeamInvitationBanner";
import VaultContextBar from "./VaultContextBar";
import VaultSwitcherMenu from "../vault/VaultSwitcherMenu";
import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useLayoutStore, findLeaf, getAllLeaves } from "../../stores/layoutStore";
import { useAuthStore } from "../../stores/authStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useTierStore } from "../../stores/tierStore";
import { invoke } from "../../lib/electron";
import CloudSyncIndicator from "../vault/CloudSyncIndicator";
import TeamSyncIndicator from "../vault/TeamSyncIndicator";

export default function Sidebar() {
  const [searchQuery, setSearchQuery] = useState("");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [overlayClosing, setOverlayClosing] = useState(false);
  const [showVaultMenu, setShowVaultMenu] = useState(false);
  const vaultMenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const resizing = useRef(false);
  const [resizeActive, setResizeActive] = useState(false);
  const scrollTopRef = useRef(0);
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { entries, folders, loadAll } = useEntryStore();
  const { isUnlocked, currentVaultPath } = useVaultStore();
  const { isExpanded, expandedWidth, expand, collapse, setExpandedWidth } =
    useSidebarStore();
  const { user, authMode, signOut } = useAuthStore();
  const { teamVaults, myRole } = useTeamStore();
  const canCreateEntries = useTeamStore((s) => s.canCreate);
  const { isTeamMember } = useAuthStore();
  const { vaultType, teamVaultId, isNetworkVault } = useVaultStore();
  const { isTrialing, trialDaysRemaining, trialEligible, trialUrgency } = useTierStore();
  const [trialPromoDismissed, setTrialPromoDismissed] = useState(() =>
    localStorage.getItem("conduit:trial-promo-dismissed") === "true"
  );
  const showTrialPromo = trialEligible && !trialPromoDismissed && isUnlocked;

  const dismissTrialPromo = useCallback(() => {
    setTrialPromoDismissed(true);
    localStorage.setItem("conduit:trial-promo-dismissed", "true");
  }, []);
  const isTeamVaultActive = vaultType === "team";
  const [onboardingDismissed, setOnboardingDismissed] = useState(() =>
    localStorage.getItem("conduit:team-onboarding-dismissed") === "true"
  );
  const showTeamOnboarding =
    isTeamMember && myRole === "admin" && teamVaults.length === 0 && isUnlocked && !onboardingDismissed;

  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    localStorage.setItem("conduit:team-onboarding-dismissed", "true");
  }, []);

  // Load entries when vault is unlocked
  useEffect(() => {
    if (isUnlocked) {
      loadAll();
    }
  }, [isUnlocked, loadAll]);

  // Homepage search delegation — expand sidebar and focus search input
  useEffect(() => {
    const handleFocusSearch = () => {
      expand();
      setTimeout(() => searchInputRef.current?.focus(), 200);
    };

    const handleSidebarSearch = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.query) {
        setSearchQuery(detail.query);
      }
      expand();
      setTimeout(() => searchInputRef.current?.focus(), 200);
    };

    document.addEventListener("conduit:focus-sidebar-search", handleFocusSearch);
    document.addEventListener("conduit:sidebar-search", handleSidebarSearch);

    return () => {
      document.removeEventListener("conduit:focus-sidebar-search", handleFocusSearch);
      document.removeEventListener("conduit:sidebar-search", handleSidebarSearch);
    };
  }, [expand]);

  // Load persisted favorites filter state
  useEffect(() => {
    invoke<boolean | null>("ui_state_get", { key: "favorites-filter" }).then((val) => {
      if (typeof val === "boolean") setShowFavoritesOnly(val);
    }).catch(() => {});
  }, []);

  const handleToggleFavorites = () => {
    const next = !showFavoritesOnly;
    setShowFavoritesOnly(next);
    invoke("ui_state_set", { key: "favorites-filter", value: next }).catch(() => {});
  };

  // Close vault menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        vaultMenuRef.current &&
        !vaultMenuRef.current.contains(e.target as Node)
      ) {
        setShowVaultMenu(false);
      }
    };
    if (showVaultMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showVaultMenu]);

  const handleNewEntry = () => {
    document.dispatchEvent(new CustomEvent("conduit:new-entry"));
  };

  const handleNewFolder = () => {
    document.dispatchEvent(new CustomEvent("conduit:new-folder"));
  };

  const handleSettings = () => {
    document.dispatchEvent(new CustomEvent("conduit:settings"));
  };

  const handleHome = useCallback(() => {
    const HOME_ID = "__home__";
    const sessionStore = useSessionStore.getState();
    const layoutStore = useLayoutStore.getState();

    // If home session already exists, activate it
    const existing = sessionStore.sessions.find((s) => s.id === HOME_ID);
    if (existing) {
      const allLeaves = getAllLeaves(layoutStore.root);
      const pane = allLeaves.find((l) => l.sessionIds.includes(HOME_ID));
      if (pane) {
        layoutStore.setFocusedPane(pane.id);
        layoutStore.setActiveSessionInPane(pane.id, HOME_ID);
      }
      return;
    }

    // No sessions at all — clear selection to show dashboard naturally
    if (sessionStore.sessions.length === 0) {
      useEntryStore.getState().clearSelection();
      return;
    }

    // Create home session
    sessionStore.addSession({
      id: HOME_ID,
      type: "dashboard",
      title: "Home",
      status: "connected",
    });

    // Move it to leftmost position in the focused pane
    const { focusedPaneId, root } = useLayoutStore.getState();
    const pane = findLeaf(root, focusedPaneId);
    if (pane) {
      const currentIndex = pane.sessionIds.indexOf(HOME_ID);
      if (currentIndex > 0) {
        layoutStore.reorderSessionInPane(focusedPaneId, currentIndex, 0);
      }
    }
  }, []);

  // Team vault unlock/setup handlers — dispatch events for App.tsx
  const handleNeedDeviceSetup = () => {
    document.dispatchEvent(new CustomEvent("conduit:device-setup"));
  };
  const handleTeamVaultUnlock = (vault: TeamVaultSummary) => {
    document.dispatchEvent(
      new CustomEvent("conduit:team-vault-unlock", { detail: vault })
    );
  };

  const isCreateDisabled = vaultType === "team" && !canCreateEntries();

  // Extract vault filename for display
  const vaultName = isTeamVaultActive
    ? (teamVaults.find((v) => v.id === teamVaultId)?.name ?? "Team Vault")
    : currentVaultPath
      ? currentVaultPath.split(/[/\\]/).pop()?.replace(".conduit", "") ?? "Vault"
      : "No Vault";

  const totalItems = entries.length + folders.length;
  const favoriteCount = entries.filter((e) => e.is_favorite).length;

  // Drag resize handler
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizing.current = true;
      setResizeActive(true);
      const startX = e.clientX;
      const startWidth = expandedWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizing.current) return;
        const delta = ev.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + delta, 150), 500);
        setExpandedWidth(newWidth);
      };

      const onMouseUp = () => {
        resizing.current = false;
        setResizeActive(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [expandedWidth, setExpandedWidth]
  );

  // Animated collapse — plays slide-out then unmounts
  const overlayClosingRef = useRef(false);
  const animatedCollapse = useCallback(() => {
    if (!isExpanded || overlayClosingRef.current) return;
    overlayClosingRef.current = true;
    setOverlayClosing(true);
    setTimeout(() => {
      overlayClosingRef.current = false;
      setOverlayClosing(false);
      collapse();
    }, 200); // matches animation duration
  }, [isExpanded, collapse]);

  // Let keyboard shortcut (Ctrl+B) trigger the animated collapse
  useEffect(() => {
    const handler = () => animatedCollapse();
    document.addEventListener("conduit:animated-collapse", handler);
    return () => document.removeEventListener("conduit:animated-collapse", handler);
  }, [animatedCollapse]);

  // ── Full sidebar content (panel) ──
  const sidebarContent = (
    <>
      {/* Header */}
      <div className={`flex items-center justify-between p-3 ${isTeamVaultActive ? "border-l-2 border-l-team-border-strong bg-team" : ""}`}>
        <div className="flex items-center gap-1 min-w-0">
          {/* Close button — hamburger X matching the tab bar toggle */}
          <button
            onClick={animatedCollapse}
            className="p-1.5 -ml-1 mr-0.5 rounded hover:bg-raised text-ink-muted hover:text-ink flex-shrink-0 transition-colors"
            title="Close sidebar (Ctrl+B)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="2" y1="2" x2="12" y2="12" />
              <line x1="12" y1="2" x2="2" y2="12" />
            </svg>
          </button>
          <div className="relative min-w-0" ref={vaultMenuRef}>
            <button
              onClick={() => setShowVaultMenu(!showVaultMenu)}
              className="flex items-center gap-1 text-sm font-semibold text-ink-secondary hover:text-ink truncate"
              title={isNetworkVault ? `Network vault — ${currentVaultPath}` : (currentVaultPath ?? "Open a vault")}
            >
              {vaultName}
              <ChevronDownIcon
                size={14}
                className="text-ink-muted flex-shrink-0"
              />
            </button>
            {showVaultMenu && (
              <VaultSwitcherMenu
                onClose={() => setShowVaultMenu(false)}
                onNeedDeviceSetup={handleNeedDeviceSetup}
                onTeamVaultUnlock={handleTeamVaultUnlock}
              />
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleFavorites}
            className={`p-1.5 rounded hover:bg-raised ${showFavoritesOnly ? "text-yellow-400" : "text-ink-muted hover:text-ink"}`}
            title={showFavoritesOnly ? "Show all entries" : "Show favorites only"}
          >
            {showFavoritesOnly ? <StarFilledIcon size={16} /> : <StarIcon size={16} />}
          </button>
          <button
            onClick={handleNewEntry}
            disabled={isCreateDisabled}
            className={`p-1.5 rounded hover:bg-raised ${isCreateDisabled ? "opacity-30 cursor-not-allowed" : "text-ink-muted hover:text-ink"}`}
            title={isCreateDisabled ? "View-only access" : "New Entry (Ctrl+E)"}
          >
            <PlusIcon size={16} />
          </button>
          <button
            onClick={handleNewFolder}
            disabled={isCreateDisabled}
            className={`p-1.5 rounded hover:bg-raised ${isCreateDisabled ? "opacity-30 cursor-not-allowed" : "text-ink-muted hover:text-ink"}`}
            title={isCreateDisabled ? "View-only access" : "New Folder (Ctrl+Shift+N)"}
          >
            <FolderPlusIcon size={16} />
          </button>
        </div>
      </div>

      {/* Team vault context bar */}
      <VaultContextBar />

      {/* Admin onboarding card */}
      {showTeamOnboarding && (
        <div className="mx-2 mt-2 p-3 rounded-lg bg-conduit-500/5 border border-conduit-500/20">
          <div className="flex items-start gap-2">
            <UsersIcon size={16} className="text-conduit-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink">Create your first team vault</p>
              <p className="text-[11px] text-ink-muted mt-0.5">
                Share credentials securely with your team.
              </p>
              <button
                onClick={() => {
                  document.dispatchEvent(new CustomEvent("conduit:create-team-vault"));
                  dismissOnboarding();
                }}
                className="mt-2 px-3 py-1 text-xs bg-conduit-600 text-white rounded hover:bg-conduit-500 transition-colors"
              >
                Create Team Vault
              </button>
            </div>
            <button
              onClick={dismissOnboarding}
              className="p-0.5 text-ink-faint hover:text-ink-muted flex-shrink-0"
              title="Dismiss"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Team invitation banner */}
      <TeamInvitationBanner />

      {/* Search */}
      <div className="p-2">
        <div className="flex items-center gap-2 px-3 py-2 bg-well rounded-md">
          <SearchIcon size={16} className="text-ink-muted" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search entries..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
          />
        </div>
      </div>

      {/* Entry Tree */}
      <div
        ref={(el) => {
          if (el) el.scrollTop = scrollTopRef.current;
        }}
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
          const el = e.currentTarget;
          // Fade scrollbar in
          el.style.setProperty("--sb-opacity", "0.35");
          if (scrollIdleTimer.current) clearTimeout(scrollIdleTimer.current);
          scrollIdleTimer.current = setTimeout(() => {
            // Fade scrollbar out over 1000ms, time-based for smooth animation
            const duration = 1000;
            const startOpacity = 0.35;
            const startTime = performance.now();
            const step = (now: number) => {
              const progress = Math.min((now - startTime) / duration, 1);
              const opacity = startOpacity * (1 - progress);
              el.style.setProperty("--sb-opacity", String(opacity));
              if (progress < 1) requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }, 800);
        }}
        className="flex-1 overflow-y-auto overflow-x-auto px-2 scrollbar-autohide"
      >
        <div className="min-w-fit">
          <EntryTree searchQuery={searchQuery} showFavoritesOnly={showFavoritesOnly} />
        </div>
      </div>

      {/* Trial promotion / status */}
      {showTrialPromo && (
        <div className="mx-2 mb-2 p-3 rounded-lg bg-conduit-500/5 border border-conduit-500/20">
          <div className="flex items-start gap-2">
            <SparklesIcon size={16} className="text-conduit-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-ink">Try Pro free for 30 days</p>
              <button
                onClick={() => invoke("auth_open_pricing")}
                className="mt-2 px-3 py-1 text-xs bg-conduit-600 text-white rounded hover:bg-conduit-500 transition-colors"
              >
                Start Free Trial →
              </button>
            </div>
            <button
              onClick={dismissTrialPromo}
              className="p-0.5 text-ink-faint hover:text-ink-muted flex-shrink-0"
              title="Dismiss"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        </div>
      )}
      {isTrialing && trialDaysRemaining >= 0 && (
        <div className={`mx-2 mb-2 px-3 py-2 rounded-lg border ${
          trialUrgency === 'urgent' ? 'bg-red-500/5 border-red-500/20' :
          trialUrgency === 'moderate' ? 'bg-amber-500/5 border-amber-500/20' :
          'bg-conduit-500/5 border-conduit-500/20'
        }`}>
          <div className="flex items-center gap-2">
            <ClockIcon size={14} className={
              trialUrgency === 'urgent' ? 'text-red-400' :
              trialUrgency === 'moderate' ? 'text-amber-400' :
              'text-conduit-400'
            } />
            <span className={`text-xs font-medium ${
              trialUrgency === 'urgent' ? 'text-red-400' :
              trialUrgency === 'moderate' ? 'text-amber-400' :
              'text-ink'
            }`}>
              Pro Trial — {trialDaysRemaining} {trialDaysRemaining === 1 ? 'day' : 'days'} left
            </span>
          </div>
        </div>
      )}
      {/* Footer — home + settings + account */}
      <div className="border-t border-stroke-dim">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1">
            <span className="text-xs text-ink-faint">
              {showFavoritesOnly
                ? `${favoriteCount} ${favoriteCount === 1 ? "favorite" : "favorites"}`
                : `${totalItems} ${totalItems === 1 ? "item" : "items"}`}
            </span>
            <CloudSyncIndicator />
            <TeamSyncIndicator />
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleHome}
              className="p-1 rounded hover:bg-raised text-ink-muted hover:text-ink"
              title="Home"
            >
              <HomeIcon size={16} />
            </button>
            <button
              onClick={handleSettings}
              className="p-1 rounded hover:bg-raised text-ink-muted hover:text-ink"
              title="Settings (Ctrl+,)"
            >
              <SettingsIcon size={16} />
            </button>
          </div>
        </div>
        {user ? (
          <div className="flex items-center justify-between px-3 py-2 border-t border-stroke-dim">
            <div className="flex items-center gap-1.5 min-w-0 mr-2">
              <button
                onClick={() => document.dispatchEvent(new CustomEvent("conduit:settings", { detail: { tab: "account" } }))}
                className="text-xs text-ink-muted truncate hover:text-ink hover:underline text-left"
                title="Account Settings"
              >
                {user.email}
              </button>
              {authMode === 'cached' && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-600/20 text-amber-400 rounded flex-shrink-0">
                  offline
                </span>
              )}
            </div>
            {showSignOutConfirm ? (
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={async () => { setShowSignOutConfirm(false); await signOut(); }}
                  className="px-2 py-0.5 text-xs text-white bg-red-600 hover:bg-red-700 rounded"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowSignOutConfirm(false)}
                  className="px-2 py-0.5 text-xs hover:bg-raised rounded text-ink-muted"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSignOutConfirm(true)}
                className="p-1 rounded hover:bg-raised text-ink-muted hover:text-red-400 flex-shrink-0"
                title="Sign Out"
              >
                <LogoutIcon size={14} />
              </button>
            )}
          </div>
        ) : authMode === 'local' ? (
          <div className="px-3 py-2 border-t border-stroke-dim">
            <button
              onClick={() => useAuthStore.getState().exitToSignIn()}
              className="flex items-center gap-1.5 text-xs text-conduit-400 hover:text-conduit-300 transition-colors"
            >
              <LoginIcon size={12} />
              Sign in to start a free Pro trial
            </button>
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <>
      {/* Overlay panel + backdrop (when expanded) */}
      {(isExpanded || overlayClosing) && (
        <>
          {/* Backdrop — full screen */}
          <div
            className={`fixed inset-0 z-30 transition-opacity duration-200 ${overlayClosing ? "bg-black/0" : "bg-black/20"}`}
            onClick={animatedCollapse}
          />
          {/* Panel — left edge of screen */}
          <div
            data-sidebar-panel
            className={`fixed top-0 bottom-0 left-0 z-40 flex flex-col bg-canvas border-r border-stroke ${overlayClosing ? "animate-sidebar-out" : "animate-sidebar-in"}`}
            style={{ width: expandedWidth, boxShadow: "6px 0 20px rgba(0,0,0,0.08)" }}
          >
            {/* Accent bar — continues the app-level top bar */}
            <div className="h-[2px] bg-conduit-500 flex-shrink-0" />
            {sidebarContent}
            {/* Resize handle — wide hit area, col-resize cursor, delayed blue highlight */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute top-0 bottom-0 w-3 cursor-col-resize group"
              style={{ right: -6 }}
            >
              <div className={`absolute right-1.5 top-0 bottom-0 w-[3px] rounded-full transition-colors ${
                resizeActive
                  ? "bg-conduit-500/70 duration-0"
                  : "bg-transparent duration-200 group-hover:bg-conduit-500/50 group-hover:duration-200 group-hover:delay-[600ms]"
              }`} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
