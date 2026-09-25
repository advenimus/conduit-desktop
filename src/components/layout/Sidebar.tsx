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
import { useSidebarStore, selectIsDocked } from "../../stores/sidebarStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useLayoutStore, findLeaf, getAllLeaves } from "../../stores/layoutStore";
import { useAuthStore } from "../../stores/authStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useTierStore } from "../../stores/tierStore";
import { invoke } from "../../lib/electron";
import CloudSyncIndicator from "../vault/CloudSyncIndicator";
import TeamSyncIndicator from "../vault/TeamSyncIndicator";
import SidebarPanel from "./SidebarPanel";
import SidebarWindowControls from "./SidebarWindowControls";

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
  const isExpanded = useSidebarStore((s) => s.isExpanded);
  const isPinned = useSidebarStore((s) => s.isPinned);
  const isDocked = useSidebarStore(selectIsDocked);
  const expandedWidth = useSidebarStore((s) => s.expandedWidth);
  const expand = useSidebarStore((s) => s.expand);
  const collapse = useSidebarStore((s) => s.collapse);
  const togglePin = useSidebarStore((s) => s.togglePin);
  const setExpandedWidth = useSidebarStore((s) => s.setExpandedWidth);
  const saveExpandedWidth = useSidebarStore((s) => s.saveExpandedWidth);
  const setMenuOpen = useSidebarStore((s) => s.setMenuOpen);
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

  useEffect(() => {
    setMenuOpen(showVaultMenu);
    return () => setMenuOpen(false);
  }, [showVaultMenu, setMenuOpen]);

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
      let targetWidth = startWidth;
      let frame = 0;

      // One layout pass per frame: a docked resize reflows every session.
      const onMouseMove = (ev: MouseEvent) => {
        if (!resizing.current) return;
        targetWidth = startWidth + ev.clientX - startX;
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            setExpandedWidth(targetWidth);
          });
        }
      };

      const onMouseUp = () => {
        resizing.current = false;
        setResizeActive(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cancelAnimationFrame(frame);
        setExpandedWidth(targetWidth);
        saveExpandedWidth();
        document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [expandedWidth, setExpandedWidth, saveExpandedWidth]
  );

  // Animated collapse — plays slide-out then unmounts
  const overlayClosingRef = useRef(false);
  const animatedCollapse = useCallback(() => {
    if (!isExpanded || overlayClosingRef.current) return;
    if (isDocked) {
      // Instant: animating a docked width would reflow every session each frame.
      collapse();
      return;
    }
    overlayClosingRef.current = true;
    setOverlayClosing(true);
    setTimeout(() => {
      overlayClosingRef.current = false;
      setOverlayClosing(false);
      // Pinned mid-animation: keep the now-docked sidebar.
      if (!selectIsDocked(useSidebarStore.getState())) collapse();
    }, 200); // matches animation duration
  }, [isExpanded, isDocked, collapse]);

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
          <SidebarWindowControls
            isPinned={isPinned}
            isDocked={isDocked}
            onClose={animatedCollapse}
            onTogglePin={togglePin}
          />
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
        <div className="flex items-center gap-2 h-9 px-2.5 bg-well rounded-md">
          <SearchIcon size={16} className="text-ink-muted flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Search entries..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchQuery) {
                e.stopPropagation();
                setSearchQuery("");
              }
            }}
            // data-bare opts out of the global/platform input chrome (border, fill,
            // focus outline, WinUI bottom accent) — the row is the visible field here
            data-bare
            className="flex-1 min-w-0 h-full bg-transparent text-sm leading-5 text-ink outline-none focus-visible:outline-none placeholder:text-ink-faint"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
              className="flex-shrink-0 p-0.5 rounded-full text-ink-faint hover:text-ink hover:bg-raised transition-colors"
              title="Clear search"
              aria-label="Clear search"
            >
              <CloseIcon size={12} />
            </button>
          )}
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

  if (!isExpanded && !overlayClosing) return null;

  return (
    <SidebarPanel
      docked={isDocked}
      closing={overlayClosing}
      width={expandedWidth}
      resizeActive={resizeActive}
      onBackdropClick={animatedCollapse}
      onResizeStart={handleResizeStart}
    >
      {sidebarContent}
    </SidebarPanel>
  );
}
