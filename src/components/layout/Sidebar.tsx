import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDownIcon, ClockIcon, LockOpenIcon } from "../../lib/icons";
import { useStartupVaultStore } from "../../stores/startupVaultStore";
import { INDICATOR_TEXT } from "../../lib/startup-vault-copy";
import { Badge, Button, Callout, IconButton, SearchInput, cx } from "../ui";
import EntryTree from "../entries/EntryTree";
import { TeamInvitationBanner } from "./TeamInvitationBanner";
import VaultContextBar from "./VaultContextBar";
import VaultSwitcherMenu from "../vault/VaultSwitcherMenu";
import { useEntryStore } from "../../stores/entryStore";
import { useVaultStore } from "../../stores/vaultStore";
import { useSidebarStore, selectIsDocked } from "../../stores/sidebarStore";
import { useAuthStore } from "../../stores/authStore";
import { useTeamStore, type TeamVaultSummary } from "../../stores/teamStore";
import { useTierStore } from "../../stores/tierStore";
import { invoke } from "../../lib/electron";
import { openHome } from "../../lib/openHome";
import CloudSyncIndicator from "../vault/CloudSyncIndicator";
import TeamSyncIndicator from "../vault/TeamSyncIndicator";
import PersonalSyncIndicator from "../sync/PersonalSyncIndicator";
import SidebarPanel from "./SidebarPanel";
import SidebarWindowControls from "./SidebarWindowControls";
import { hasInsetTitleBar } from "../../lib/titleBar";

const CREATE_DISABLED_REASON = "View-only access";
const INSET_TITLE_BAR = hasInsetTitleBar();

const TRIAL_TONES = {
  urgent: { box: "bg-danger-bg border-danger-border text-danger", icon: "text-danger" },
  moderate: { box: "bg-warning-bg border-warning-border text-warning", icon: "text-warning" },
  none: { box: "bg-info-bg border-info-border text-ink", icon: "text-info" },
} as const;

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
  const autoUnlockOn = useStartupVaultStore((s) => s.status?.currentOn ?? false) && vaultType === "personal";
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

  const trialTone = TRIAL_TONES[trialUrgency === "urgent" || trialUrgency === "moderate" ? trialUrgency : "none"];

  const vaultSwitcher = (
    <div className="relative min-w-0 flex-1" ref={vaultMenuRef}>
      <button
        type="button"
        data-cv-vault-switcher
        onClick={() => setShowVaultMenu(!showVaultMenu)}
        className="flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded px-1 text-body font-semibold text-ink hover:bg-hover"
        title={`${isNetworkVault ? `Network vault — ${currentVaultPath}` : (currentVaultPath ?? "Open a vault")}${autoUnlockOn ? ` · ${INDICATOR_TEXT}` : ""}`}
      >
        <span className="min-w-0 truncate">{vaultName}</span>
        {autoUnlockOn && (
          <span data-cv-auto-unlock-indicator="" className="inline-flex shrink-0">
            <LockOpenIcon size={12} className="text-ink-faint" />
            <span className="sr-only">{INDICATOR_TEXT}</span>
          </span>
        )}
        <ChevronDownIcon size={16} className="-ml-0.5 shrink-0 text-ink-muted" />
      </button>
      {showVaultMenu && (
        <VaultSwitcherMenu
          onClose={() => setShowVaultMenu(false)}
          onNeedDeviceSetup={handleNeedDeviceSetup}
          onTeamVaultUnlock={handleTeamVaultUnlock}
        />
      )}
    </div>
  );

  // ── Full sidebar content (panel) ──
  const sidebarContent = (
    <>
      {/* Header */}
      <div
        data-cv-sidebar-header
        data-cv-titlebar=""
        className={cx(
          "flex h-tabstrip shrink-0 items-center gap-0.5 px-1",
          isTeamVaultActive && "border-l-2 border-l-team-border-strong bg-team",
        )}
      >
        <SidebarWindowControls
          isPinned={isPinned}
          isDocked={isDocked}
          onClose={animatedCollapse}
          onTogglePin={togglePin}
        />
        {!INSET_TITLE_BAR && vaultSwitcher}
        {INSET_TITLE_BAR && <div className="flex-1" />}
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={showFavoritesOnly ? "starFilled" : "star"}
            label={showFavoritesOnly ? "Show all entries" : "Show favorites only"}
            onClick={handleToggleFavorites}
            tone={showFavoritesOnly ? "inherit" : "default"}
            className={showFavoritesOnly ? "text-favorite" : undefined}
          />
          <IconButton
            icon="plus"
            label="New Entry"
            title={isCreateDisabled ? CREATE_DISABLED_REASON : "New Entry (Ctrl+E)"}
            disabled={isCreateDisabled}
            disabledReason={CREATE_DISABLED_REASON}
            onClick={handleNewEntry}
          />
          <IconButton
            icon="folderPlus"
            label="New Folder"
            title={isCreateDisabled ? CREATE_DISABLED_REASON : "New Folder (Ctrl+Shift+N)"}
            disabled={isCreateDisabled}
            disabledReason={CREATE_DISABLED_REASON}
            onClick={handleNewFolder}
          />
        </div>
      </div>

      {/* The macOS window buttons take the header's start, so the vault name gets a row of its own. */}
      {INSET_TITLE_BAR && (
        <div className={cx("flex h-8 shrink-0 items-center px-1", isTeamVaultActive && "border-l-2 border-l-team-border-strong bg-team")}>
          {vaultSwitcher}
        </div>
      )}

      {/* Team vault context bar */}
      <VaultContextBar />

      {/* Admin onboarding card */}
      {showTeamOnboarding && (
        <Callout
          tone="info"
          size="sm"
          icon="users"
          title="Create your first team vault"
          className="mx-2 mt-2"
          onDismiss={dismissOnboarding}
          actions={
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                document.dispatchEvent(new CustomEvent("conduit:create-team-vault"));
                dismissOnboarding();
              }}
            >
              Create Team Vault
            </Button>
          }
        >
          Share credentials securely with your team.
        </Callout>
      )}

      {/* Team invitation banner */}
      <TeamInvitationBanner />

      {/* Search */}
      <div data-cv-sidebar-search className="px-2 pb-2">
        <SearchInput
          ref={searchInputRef}
          placeholder="Search entries..."
          value={searchQuery}
          onChange={setSearchQuery}
          onKeyDown={(e) => {
            if (e.key === "Escape" && searchQuery) {
              e.stopPropagation();
              setSearchQuery("");
            }
          }}
        />
      </div>

      {/* Entry Tree */}
      <div
        ref={(el) => {
          if (el) el.scrollTop = scrollTopRef.current;
        }}
        onScroll={(e) => {
          scrollTopRef.current = e.currentTarget.scrollTop;
          const el = e.currentTarget;
          // base.css scales the thumb token by --sb-opacity, so 1 shows the token color itself
          el.style.setProperty("--sb-opacity", "1");
          if (scrollIdleTimer.current) clearTimeout(scrollIdleTimer.current);
          scrollIdleTimer.current = setTimeout(() => {
            // Fade scrollbar out over 1000ms, time-based for smooth animation
            const duration = 1000;
            const startOpacity = 1;
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
        className="flex-1 overflow-y-auto overflow-x-auto px-1 scrollbar-autohide"
      >
        <div className="min-w-fit">
          <EntryTree searchQuery={searchQuery} showFavoritesOnly={showFavoritesOnly} />
        </div>
      </div>

      {/* Trial promotion / status */}
      {showTrialPromo && (
        <Callout
          tone="info"
          size="sm"
          icon="sparkles"
          title="Try Pro free for 30 days"
          className="mx-2 mb-2"
          onDismiss={dismissTrialPromo}
          actions={
            <Button size="sm" variant="primary" onClick={() => invoke("auth_open_pricing")}>
              Start Free Trial →
            </Button>
          }
        />
      )}
      {isTrialing && trialDaysRemaining >= 0 && (
        <div className={cx("mx-2 mb-2 flex h-7 items-center gap-2 rounded-md border px-2 text-label font-semibold", trialTone.box)}>
          <ClockIcon size={16} className={cx("shrink-0", trialTone.icon)} />
          <span className="truncate">
            Pro Trial — {trialDaysRemaining} {trialDaysRemaining === 1 ? 'day' : 'days'} left
          </span>
        </div>
      )}
      {/* Footer — home + settings + account */}
      <div data-cv-sidebar-footer className="shrink-0 border-t border-divider">
        <div className="flex h-8 items-center justify-between gap-1 px-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="text-meta text-ink-faint tabular-nums whitespace-nowrap">
              {showFavoritesOnly
                ? `${favoriteCount} ${favoriteCount === 1 ? "favorite" : "favorites"}`
                : `${totalItems} ${totalItems === 1 ? "item" : "items"}`}
            </span>
            <PersonalSyncIndicator />
            <CloudSyncIndicator />
            <TeamSyncIndicator />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton icon="home" label="Home" onClick={openHome} />
            <IconButton icon="settings" label="Settings" title="Settings (Ctrl+,)" onClick={handleSettings} />
          </div>
        </div>
        {user ? (
          <div className="flex h-8 items-center justify-between gap-2 px-2 border-t border-divider">
            <div className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => document.dispatchEvent(new CustomEvent("conduit:settings", { detail: { tab: "account" } }))}
                className="min-w-0 truncate text-left text-label text-ink-muted hover:text-ink hover:underline"
                title="Account Settings"
              >
                {user.email}
              </button>
              {authMode === 'cached' && (
                <Badge tone="warning" className="shrink-0">
                  offline
                </Badge>
              )}
            </div>
            {showSignOutConfirm ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={async () => { setShowSignOutConfirm(false); await signOut(); }}
                >
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowSignOutConfirm(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <IconButton icon="logout" tone="danger" label="Sign Out" onClick={() => setShowSignOutConfirm(true)} />
            )}
          </div>
        ) : authMode === 'local' ? (
          <div className="px-2 py-1.5 border-t border-divider">
            <Button variant="link" size="sm" icon="login" onClick={() => useAuthStore.getState().exitToSignIn()}>
              Sign in to start a free Pro trial
            </Button>
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
