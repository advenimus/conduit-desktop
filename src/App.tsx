import { useState, useEffect, useCallback, useRef } from "react";
import Sidebar from "./components/layout/Sidebar";
import SplitContainer from "./components/layout/SplitContainer";
import { ChatPanel } from "./components/ai";
import { invoke } from "./lib/electron";
import QuickConnect from "./components/connections/QuickConnect";
import SettingsDialog, { type SettingsTab } from "./components/settings/SettingsDialog";
import CredentialManager from "./components/vault/CredentialManager";
import UnlockDialog from "./components/vault/UnlockDialog";
import CloudRestoreDialog from "./components/vault/CloudRestoreDialog";
import VaultHub from "./components/vault/VaultHub";
import EntryDialog from "./components/entries/EntryDialog";
import FolderDialog from "./components/entries/FolderDialog";
import { ToastController, toast, setPushOverlayState } from "./components/common/Toast";
import UpdateNotificationBridge, { setPushUpdateState } from "./components/common/UpdateNotification";
import type { SerializedToast, OverlayState, UpdateState } from "./types/toast";
import StartupStatus from "./components/common/StartupStatus";
import AboutDialog from "./components/about/AboutDialog";
import PasswordGeneratorDialog from "./components/tools/PasswordGeneratorDialog";
import SshKeyGeneratorDialog from "./components/tools/SshKeyGeneratorDialog";
import ImportDialog from "./components/import/ImportDialog";
import ExportDialog from "./components/vault/ExportDialog";
import VaultImportDialog from "./components/vault/VaultImportDialog";
import RenameVaultDialog from "./components/vault/RenameVaultDialog";
import ChangePasswordDialog from "./components/vault/ChangePasswordDialog";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAppearance } from "./lib/appearance/useAppearance";
import { useSessionStore, type SessionType } from "./stores/sessionStore";
import { useLayoutStore, findLeaf } from "./stores/layoutStore";
import { useEntryStore } from "./stores/entryStore";
import { useVaultStore } from "./stores/vaultStore";
import { useSidebarStore, selectIsDockedOpen, maxRightPanelWidth } from "./stores/sidebarStore";
import { useAuthStore } from "./stores/authStore";
import { useAiStore } from "./stores/aiStore";
import { isEngineType } from "./lib/ai-harnesses";
import { localNetworkPermissionMessage, localNetworkSettingsAppName } from "./lib/errorMessages";
import { initTierSubscriptions, useTierStore } from "./stores/tierStore";
import { useTeamStore } from "./stores/teamStore";
import AuthScreen from "./components/auth/AuthScreen";
import OnboardingWizard from "./components/onboarding/OnboardingWizard";
import WhatsNewDialog from "./components/whats-new/WhatsNewDialog";
import DeviceSetupDialog from "./components/vault/DeviceSetupDialog";
import CreateTeamVaultDialog from "./components/vault/CreateTeamVaultDialog";
import TeamVaultUnlock from "./components/vault/TeamVaultUnlock";
import DeviceAuthApprovalDialog from "./components/vault/DeviceAuthApprovalDialog";
import VaultSettingsDialog from "./components/vault/VaultSettingsDialog";
import FeedbackDialog from "./components/feedback/FeedbackDialog";
import SyncLayer from "./components/sync/SyncLayer";
import SyncBanners from "./components/sync/SyncBanners";
import { useBackupStates } from "./hooks/useBackupStates";
import { useFreeze } from "./lib/native-freeze";
import type { TeamVaultSummary } from "./stores/teamStore";
import { Banner, IconButton } from "./components/ui";
import FullScreenSpinner from "./components/common/FullScreenSpinner";
import { useStartupVaultStore } from "./stores/startupVaultStore";
import { goToVaultHubFromStartup, installStartupInputReporters, reportInputScreen, runStartupVault } from "./lib/startup-vault";
import { handleAutoUnlockEvent } from "./lib/startup-vault-events";
import StartupConfirmHost from "./components/vault/StartupConfirmHost";

/**
 * Notification controllers — manage toast + update state and push to overlay window.
 * No DOM output; rendering happens in the transparent overlay BrowserWindow.
 */
function NotificationStack() {
  const latestToasts = useRef<SerializedToast[]>([]);
  const latestUpdate = useRef<UpdateState | null>(null);

  const pushCombinedState = useCallback(() => {
    const state: OverlayState = {
      toasts: latestToasts.current,
      update: latestUpdate.current,
    };
    console.log(`[overlay:push] toasts=${state.toasts.length} update=${!!state.update}`);
    window.electron.send("overlay:push-state", state);
  }, []);

  useEffect(() => {
    setPushOverlayState((toasts: SerializedToast[]) => {
      latestToasts.current = toasts;
      pushCombinedState();
    });
    setPushUpdateState((update: UpdateState | null) => {
      latestUpdate.current = update;
      pushCombinedState();
    });
    return () => {
      setPushOverlayState(() => {});
      setPushUpdateState(() => {});
    };
  }, [pushCombinedState]);

  return (
    <>
      <ToastController />
      <UpdateNotificationBridge />
    </>
  );
}

const AI_PANEL_DIVIDER_WIDTH = 4;

/** Cached auth: the centered strip under the accent line (spec 3.8). It has no role="status": the harness reads only sync banners by role. */
function OfflineBanner() {
  return (
    <Banner
      tone="warn"
      icon="wifiOff"
      status={false}
      align="center"
      className="shrink-0"
      actions={[{ label: "Reconnect", onClick: () => void useAuthStore.getState().tryReauthenticate() }]}
    >
      Working offline — using cached features
    </Banner>
  );
}

installStartupInputReporters();

function App() {
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiPanelWidth, setAiPanelWidth] = useState(400);
  const aiResizing = useRef(false);
  const [aiDragging, setAiDragging] = useState(false);
  const [showQuickConnect, setShowQuickConnect] = useState(false);
  const [showSettings, setShowSettings] = useState<SettingsTab | false>(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [showEntryDialog, setShowEntryDialog] = useState(false);
  const [newEntryFolderId, setNewEntryFolderId] = useState<string | null>(null);
  const [showFolderDialog, setShowFolderDialog] = useState(false);
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const [showCloudRestore, setShowCloudRestore] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showPasswordGenerator, setShowPasswordGenerator] = useState(false);
  const [showSshKeyGenerator, setShowSshKeyGenerator] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showVaultImportDialog, setShowVaultImportDialog] = useState(false);
  const [showRenameVaultDialog, setShowRenameVaultDialog] = useState(false);
  const [showChangePasswordDialog, setShowChangePasswordDialog] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [showDeviceSetup, setShowDeviceSetup] = useState(false);
  const [showCreateTeamVault, setShowCreateTeamVault] = useState(false);
  // Audit log is now embedded in VaultSettingsDialog (activity tab)
  const [teamVaultToUnlock, setTeamVaultToUnlock] = useState<TeamVaultSummary | null>(null);
  const [pendingDeviceAuth, setPendingDeviceAuth] = useState<{ id: string; requesting_device_name: string } | null>(null);
  const [showVaultSettings, setShowVaultSettings] = useState<{ tab?: 'members' | 'permissions' | 'activity'; folderId?: string } | false>(false);
  const [feedbackType, setFeedbackType] = useState<"bug" | "feedback" | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | undefined>(undefined);
  const whatsNewChecked = useRef(false);
  const onboardingChecked = useRef(false);
  const { showVaultHub, autoConnectInProgress } = useVaultStore();
  const startupPending = useStartupVaultStore((s) => s.pending);
  const startupOpening = useStartupVaultStore((s) => s.opening);
  const startupRan = useRef(false);
  const { isAuthenticated, isInitializing, authMode, handleAuthStateChanged } = useAuthStore();
  // cli_agents_enabled is read by ChatPanel via useAiStore directly
  // Derive a stable key from profile tier/team status so the tier capabilities
  // effect re-runs when the profile loads (fixes race condition for team members).
  const profileTierKey = useAuthStore((s) => {
    const p = s.profile;
    return p ? `${p.is_team_member}-${p.tier_id}` : null;
  });

  // Initialize hooks
  useKeyboardShortcuts();
  useAppearance();
  useBackupStates();

  // Remove splash screen once React has mounted
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.classList.add('splash-fade-out');
      setTimeout(() => splash.remove(), 400);
    }
  }, []);

  // Initialize auth on mount
  useEffect(() => {
    useAuthStore.getState().initialize();
    initTierSubscriptions();
  }, []);

  // Trial expiration warnings
  useEffect(() => {
    const unsub = useTierStore.subscribe((state, prevState) => {
      if (!state.isTrialing || state.trialDaysRemaining < 0) return;
      if (prevState.trialDaysRemaining === state.trialDaysRemaining) return;

      const days = state.trialDaysRemaining;
      const lastWarningKey = `conduit:trial-warning-${days <= 1 ? '1' : days <= 3 ? '3' : days <= 7 ? '7' : 'none'}`;

      // Only show each warning level once per day
      const lastShown = localStorage.getItem(lastWarningKey);
      const today = new Date().toDateString();
      if (lastShown === today) return;

      if (days <= 1 && days > 0) {
        toast.warning('Your trial ends tomorrow. Subscribe to keep Pro features.');
        localStorage.setItem(lastWarningKey, today);
      } else if (days <= 3) {
        toast.warning(`Your trial ends in ${days} days. Subscribe to keep access.`);
        localStorage.setItem(lastWarningKey, today);
      } else if (days <= 7) {
        toast.info(`Your trial ends in ${days} days.`);
        localStorage.setItem(lastWarningKey, today);
      }
    });
    return unsub;
  }, []);

  // Trial conversion / expiration detection
  useEffect(() => {
    const unsub = useTierStore.subscribe((state, prevState) => {
      if (prevState.isTrialing && !state.isTrialing && prevState.trialDaysRemaining >= 0) {
        const profile = useAuthStore.getState().profile;
        const status = profile?.subscription_status;
        if (status === 'active') {
          toast.success('Your trial has ended and your Pro subscription is now active.', {
            persistent: true,
            actions: [{ label: 'Relaunch', onClick: () => invoke('app_relaunch'), variant: 'primary' }],
          });
        } else if (profile?.has_used_trial) {
          toast.warning('Your trial has ended. Subscribe to keep Pro features.', {
            persistent: true,
            actions: [{ label: 'Relaunch', onClick: () => invoke('app_relaunch') }],
          });
        }
      }
    });
    return unsub;
  }, []);

  // Check onboarding status for first-time authenticated users
  useEffect(() => {
    if (!isAuthenticated || authMode !== 'authenticated' || onboardingChecked.current) return;
    onboardingChecked.current = true;

    invoke<{ onboarding_completed?: boolean }>("settings_get").then((settings) => {
      if (!settings.onboarding_completed) {
        setShowOnboarding(true);
      }
    }).catch(() => {});
  }, [isAuthenticated, authMode]);

  // Check "What's New" after onboarding — show if version changed since last seen
  useEffect(() => {
    if (!isAuthenticated || authMode !== 'authenticated' || whatsNewChecked.current) return;
    whatsNewChecked.current = true;

    (async () => {
      try {
        const settings = await invoke<{
          onboarding_completed?: boolean;
          last_seen_whats_new_version?: string | null;
        }>('settings_get');
        if (!settings.onboarding_completed) return; // onboarding not done yet

        const version = await invoke<string>('app_get_version');
        if (settings.last_seen_whats_new_version === version) return; // already seen

        // Show the dialog — it handles its own manifest loading and error states
        setWhatsNewVersion(version);
        setShowWhatsNew(true);
      } catch (err) {
        console.warn('[whats-new] Failed to check version:', err);
      }
    })();
  }, [isAuthenticated, authMode]);

  // Listen for auth state changes from main process
  useEffect(() => {
    const unlisten = window.electron.on('auth:state-changed', (state: unknown) => {
      handleAuthStateChanged(state as { user: null; profile: null; isAuthenticated: boolean; emailConfirmed: boolean });
    });
    return () => { unlisten(); };
  }, [handleAuthStateChanged]);

  // Fetch tier capabilities, models, and auto-configure backend proxy based on auth mode
  useEffect(() => {
    if (!authMode) return;
    const store = useAiStore.getState();

    if (authMode === 'local') {
      store.setLocalModeTier();
      return;
    }

    if (authMode === 'cached') {
      store.loadCachedTier();
      return;
    }

    // authMode === 'authenticated'
    if (!isAuthenticated) return;
    const setup = async () => {
      try {
        await store.fetchTierCapabilities();
      } catch {
        // Network may be temporarily down — fall back to cached tier
        if (!useAiStore.getState().tierCapabilities) {
          await store.loadCachedTier();
        }
      }
    };
    setup();
  }, [isAuthenticated, authMode, profileTierKey]);

  // Initialize team features when authenticated
  useEffect(() => {
    if (!isAuthenticated || authMode !== 'authenticated') {
      useTeamStore.getState().reset();
      return;
    }
    useTeamStore.getState().checkInvitations();
    useTeamStore.getState().loadTeam();
    useTeamStore.getState().loadTeamVaults();
  }, [isAuthenticated, authMode]);

  // Identity key setup is triggered on-demand when user tries to create/open
  // a team vault (via conduit:device-setup event), not automatically on launch.

  // Poll for pending device authorization requests (other devices waiting for approval)
  useEffect(() => {
    if (!isAuthenticated || authMode !== 'authenticated') return;
    const { isTeamMember } = useAuthStore.getState();
    if (!isTeamMember) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const pending = await invoke<Array<{ id: string; requesting_device_name: string }>>('device_auth_list_pending');
        if (!cancelled && pending.length > 0 && !pendingDeviceAuth) {
          setPendingDeviceAuth(pending[0]);
        }
      } catch { /* ignore */ }
    };

    poll();
    const timer = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isAuthenticated, authMode, pendingDeviceAuth]);

  // Background re-auth for cached mode (every 60s)
  useEffect(() => {
    if (authMode !== 'cached') return;
    const interval = setInterval(() => {
      useAuthStore.getState().tryReauthenticate();
    }, 60_000);
    // Try immediately as well
    useAuthStore.getState().tryReauthenticate();
    return () => clearInterval(interval);
  }, [authMode]);

  // Transition auth mode on network status changes. Main process detects connectivity
  // loss passively (from failed Supabase calls) and recovery via polling.
  useEffect(() => {
    const unlisten = window.electron.on('network:status-changed', (online: unknown) => {
      if (!online) {
        useAuthStore.getState().enterCachedMode();
      } else if (useAuthStore.getState().authMode === 'cached') {
        useAuthStore.getState().tryReauthenticate();
      }
    });
    return () => { unlisten(); };
  }, []);

  // Periodic profile refresh for tier enforcement (window focus + 5-min interval)
  useEffect(() => {
    if (authMode !== 'authenticated') return;

    const handleFocus = () => {
      if (navigator.onLine) useAuthStore.getState().refreshProfile();
    };
    window.addEventListener('focus', handleFocus);

    const interval = setInterval(() => {
      if (navigator.onLine) useAuthStore.getState().refreshProfile();
    }, 5 * 60_000);

    return () => {
      window.removeEventListener('focus', handleFocus);
      clearInterval(interval);
    };
  }, [authMode]);

  // Tier change notification
  useEffect(() => {
    const handleTierChanged = () => {
      toast.info('Your plan has changed. Relaunch to apply all updates.', {
        persistent: true,
        actions: [{ label: 'Relaunch', onClick: () => invoke('app_relaunch'), variant: 'primary' }],
      });
    };
    document.addEventListener('conduit:tier-changed', handleTierChanged);
    return () => document.removeEventListener('conduit:tier-changed', handleTierChanged);
  }, []);

  // Dispatch layout-changed when AI panel toggles
  useEffect(() => {
    document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
  }, [showAiPanel]);

  useEffect(() => {
    useSidebarStore.getState().setRightPanelWidth(showAiPanel ? aiPanelWidth + AI_PANEL_DIVIDER_WIDTH : 0);
  }, [showAiPanel, aiPanelWidth]);

  // Native web views paint over HTML, so these overlays freeze them while open.
  const sidebarExpanded = useSidebarStore((s) => s.isExpanded);
  const sidebarDockedOpen = useSidebarStore(selectIsDockedOpen);
  const sidebarMenuOpen = useSidebarStore((s) => s.menuOpen); // can spill past a docked sidebar's edge
  const anyOverlayOpen =
    showQuickConnect || !!showSettings || showCredentials || showEntryDialog || showFolderDialog || showUnlockDialog || showCloudRestore || showAbout || showPasswordGenerator || showSshKeyGenerator || showImportDialog || showDeviceSetup || showCreateTeamVault || !!teamVaultToUnlock || !!editingEntryId || !!editingFolderId || !!pendingDeviceAuth || !!showVaultSettings || !!showExportDialog || showVaultImportDialog || showRenameVaultDialog || showChangePasswordDialog || !!feedbackType || showWhatsNew;
  useFreeze(anyOverlayOpen, "legacy", "App overlay flags");

  // Dispatch layout-changed when sidebar mode/expansion changes
  // Immediate dispatch handles the instant part; delayed dispatch handles CSS transition end
  useEffect(() => {
    document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    const timer = setTimeout(() => {
      document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    }, 250);
    return () => clearTimeout(timer);
  }, [sidebarExpanded, sidebarDockedOpen]);

  // The floating side bar, or a docked one whose vault menu spills past its edge.
  const sidebarOverlayOpen = sidebarExpanded && (!sidebarDockedOpen || sidebarMenuOpen);
  useFreeze(sidebarOverlayOpen, "sidebar", "side bar overlay");

  // Startup vault (docs/AUTO_UNLOCK.md 4.1, 4.2): once sign-in has settled and no sign-in or
  // onboarding screen shows, main plans what opens: the hub, a team vault, or a personal vault.
  const authGatePassed = !isInitializing && (isAuthenticated || authMode === "local" || authMode === "cached");
  useEffect(() => {
    if (!authGatePassed) {
      if (!isInitializing) reportInputScreen();
      return;
    }
    if (showOnboarding) {
      reportInputScreen();
      return;
    }
    if (startupRan.current) return;
    startupRan.current = true;
    void runStartupVault();
  }, [authGatePassed, isInitializing, showOnboarding]);

  // Memoized onClose handlers for EntryDialog to prevent effect re-fires
  const closeEditingEntry = useCallback(() => setEditingEntryId(null), []);
  const closeNewEntryDialog = useCallback(() => {
    setShowEntryDialog(false);
    setNewEntryFolderId(null);
  }, []);

  // Create a new engine session via keyboard shortcut / menu event
  const handleNewAgent = useCallback(async () => {
    const store = useAiStore.getState();
    const avail = store.engineAvailability;
    // If current engine isn't available, switch to an available one
    if (avail && !avail[store.activeEngineType]) {
      const fallback = Object.entries(avail).find(([, ok]) => ok)?.[0];
      if (fallback && isEngineType(fallback)) {
        store.setActiveEngine(fallback);
      } else {
        return;
      }
    }
    store.bumpAgentSession();
  }, []);

  // AI panel resize drag handler
  const handleAiResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    aiResizing.current = true;
    setAiDragging(true);
    const startX = e.clientX;
    const startWidth = aiPanelWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!aiResizing.current) return;
      // Dragging left increases width (panel is on the right)
      const delta = startX - ev.clientX;
      const maxWidth = Math.max(
        300,
        maxRightPanelWidth(useSidebarStore.getState(), 800 + AI_PANEL_DIVIDER_WIDTH) - AI_PANEL_DIVIDER_WIDTH,
      );
      const newWidth = Math.min(Math.max(startWidth + delta, 300), maxWidth);
      setAiPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      aiResizing.current = false;
      setAiDragging(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [aiPanelWidth]);

  // Listen for custom events from keyboard shortcuts and sidebar
  useEffect(() => {
    const handleQuickConnect = () => setShowQuickConnect(true);
    const handleSettings = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab ?? "general";
      setShowSettings(tab);
    };
    const handleCredentials = () => setShowCredentials(true);
    const handleNewEntry = (e: Event) => {
      const folderId = (e as CustomEvent).detail?.folderId ?? null;
      setNewEntryFolderId(folderId);
      setShowEntryDialog(true);
    };
    const handleNewFolder = (e: Event) => {
      const parentId = (e as CustomEvent).detail?.parentId ?? null;
      setNewFolderParentId(parentId);
      setShowFolderDialog(true);
    };
    const handleEditEntry = (e: Event) => {
      const entryId = (e as CustomEvent).detail;
      if (entryId) setEditingEntryId(entryId);
    };
    const handleEditFolder = (e: Event) => {
      const folderId = (e as CustomEvent).detail;
      if (folderId) setEditingFolderId(folderId);
    };
    const handleNewTerminal = () => {
      useSessionStore.getState().createLocalShell();
    };
    const handleCloseTab = () => {
      const layoutState = useLayoutStore.getState();
      const pane = findLeaf(layoutState.root, layoutState.focusedPaneId);
      if (pane?.activeSessionId) {
        useSessionStore.getState().closeSession(pane.activeSessionId);
      }
    };
    const handleNextTab = () => {
      const layoutState = useLayoutStore.getState();
      const pane = findLeaf(layoutState.root, layoutState.focusedPaneId);
      if (!pane || pane.sessionIds.length === 0) return;
      const idx = pane.sessionIds.indexOf(pane.activeSessionId ?? "");
      const next = (idx + 1) % pane.sessionIds.length;
      layoutState.setActiveSessionInPane(pane.id, pane.sessionIds[next]);
    };
    const handlePrevTab = () => {
      const layoutState = useLayoutStore.getState();
      const pane = findLeaf(layoutState.root, layoutState.focusedPaneId);
      if (!pane || pane.sessionIds.length === 0) return;
      const idx = pane.sessionIds.indexOf(pane.activeSessionId ?? "");
      const prev = (idx - 1 + pane.sessionIds.length) % pane.sessionIds.length;
      layoutState.setActiveSessionInPane(pane.id, pane.sessionIds[prev]);
    };
    const handleSplitRight = () => {
      const layoutState = useLayoutStore.getState();
      const pane = findLeaf(layoutState.root, layoutState.focusedPaneId);
      if (pane?.activeSessionId) {
        layoutState.splitPane(pane.id, "horizontal", pane.activeSessionId);
      }
    };
    const handleSplitDown = () => {
      const layoutState = useLayoutStore.getState();
      const pane = findLeaf(layoutState.root, layoutState.focusedPaneId);
      if (pane?.activeSessionId) {
        layoutState.splitPane(pane.id, "vertical", pane.activeSessionId);
      }
    };
    const handleOpenVault = async () => {
      const filePath = await useVaultStore.getState().pickVaultFile("open");
      if (filePath) {
        await useVaultStore.getState().openVault(filePath);
        // Vault is now set but locked - trigger unlock flow
        document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
      }
    };
    const handleNewVault = async () => {
      const filePath = await useVaultStore.getState().pickVaultFile("save");
      if (filePath) {
        // Need password - dispatch event to show unlock dialog in create mode
        await useVaultStore.getState().openVault(filePath);
        // This sets vaultExists=false since file doesn't exist yet, triggering "Create" mode
        document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
      }
    };
    const handleLockVault = () => {
      useVaultStore.getState().lockVault();
      useEntryStore.setState({ entries: [], folders: [] });
      useAiStore.getState().resetConversationState();
    };
    const handleUnlockVault = () => {
      setShowUnlockDialog(true);
    };
    const handleAbout = () => setShowAbout(true);
    const handlePasswordGenerator = () => setShowPasswordGenerator(true);
    const handleSshKeyGenerator = () => setShowSshKeyGenerator(true);
    const handleImportRdm = () => setShowImportDialog(true);
    const handleExportVault = () => setShowExportDialog(true);
    const handleImportExport = () => setShowVaultImportDialog(true);
    const handleRenameVault = () => {
      const { isUnlocked, vaultType, currentVaultPath, teamVaultId } = useVaultStore.getState();
      if (!isUnlocked) return;

      if (vaultType === "team") {
        const { myVaultRole, myRole } = useTeamStore.getState();
        if (myVaultRole !== "admin" && myRole !== "admin") {
          toast.error("Only vault admins or team admins can rename this vault");
          return;
        }
        if (!teamVaultId) return;
      } else {
        if (!currentVaultPath) return;
      }

      setShowRenameVaultDialog(true);
    };
    const handleChangeVaultPassword = () => {
      const { isUnlocked, vaultType } = useVaultStore.getState();
      if (!isUnlocked) return;
      if (vaultType === "team") {
        toast.error("Password change is not available for team vaults");
        return;
      }
      setShowChangePasswordDialog(true);
    };
    const handleSaveVault = async () => {
      const { isUnlocked, vaultType, saveVault } = useVaultStore.getState();
      if (!isUnlocked) return;
      if (vaultType === "team") {
        toast.info("Team vaults are saved to cloud automatically");
        return;
      }
      try {
        await saveVault();
        toast.success("Vault saved", { duration: 2000 });
      } catch {
        toast.error("Failed to save vault");
      }
    };
    const handleNewAgentEvent = () => {
      handleNewAgent();
    };
    const handleReplayOnboarding = () => {
      onboardingChecked.current = true;
      setShowOnboarding(true);
    };
    const handleWhatsNew = () => {
      setWhatsNewVersion(undefined); // manual open — show latest
      setShowWhatsNew(true);
    };
    const handleDeviceSetup = () => setShowDeviceSetup(true);
    const handleCreateTeamVault = () => setShowCreateTeamVault(true);
    const handleTeamVaultUnlockEvent = (e: Event) => {
      const vault = (e as CustomEvent).detail as TeamVaultSummary;
      if (vault) setTeamVaultToUnlock(vault);
    };
    const handleTeamVaultAudit = () => {
      setShowVaultSettings({ tab: 'activity' });
    };
    const handleVaultSettings = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: 'members' | 'permissions' | 'activity'; folderId?: string } | undefined;
      setShowVaultSettings(detail ?? { tab: 'members' });
    };
    const handleFolderPermissions = (e: Event) => {
      const detail = (e as CustomEvent).detail as { folderId: string; folderName: string } | undefined;
      if (detail) {
        setShowVaultSettings({ tab: 'permissions', folderId: detail.folderId });
      }
    };

    document.addEventListener("conduit:replay-onboarding", handleReplayOnboarding);
    document.addEventListener("conduit:whats-new", handleWhatsNew);
    // Dev-only shortcut: Ctrl+Shift+O to force onboarding from any screen
    const isDev = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV;
    const handleDevOnboarding = isDev
      ? (e: KeyboardEvent) => {
          if (e.ctrlKey && e.shiftKey && e.key === "O") {
            e.preventDefault();
            handleReplayOnboarding();
          }
        }
      : null;
    if (handleDevOnboarding) document.addEventListener("keydown", handleDevOnboarding);
    document.addEventListener("conduit:about", handleAbout);
    document.addEventListener("conduit:quick-connect", handleQuickConnect);
    document.addEventListener("conduit:settings", handleSettings);
    document.addEventListener("conduit:credentials", handleCredentials);
    document.addEventListener("conduit:new-entry", handleNewEntry);
    document.addEventListener("conduit:new-folder", handleNewFolder);
    document.addEventListener("conduit:edit-entry", handleEditEntry);
    document.addEventListener("conduit:edit-folder", handleEditFolder);
    document.addEventListener("conduit:new-terminal", handleNewTerminal);
    document.addEventListener("conduit:close-tab", handleCloseTab);
    document.addEventListener("conduit:next-tab", handleNextTab);
    document.addEventListener("conduit:prev-tab", handlePrevTab);
    document.addEventListener("conduit:split-right", handleSplitRight);
    document.addEventListener("conduit:split-down", handleSplitDown);
    document.addEventListener("conduit:open-vault", handleOpenVault);
    document.addEventListener("conduit:new-vault", handleNewVault);
    document.addEventListener("conduit:lock-vault", handleLockVault);
    document.addEventListener("conduit:unlock-vault", handleUnlockVault);
    document.addEventListener("conduit:new-agent", handleNewAgentEvent);
    document.addEventListener("conduit:password-generator", handlePasswordGenerator);
    document.addEventListener("conduit:ssh-key-generator", handleSshKeyGenerator);
    document.addEventListener("conduit:import-rdm", handleImportRdm);
    document.addEventListener("conduit:export-vault", handleExportVault);
    document.addEventListener("conduit:import-export", handleImportExport);
    document.addEventListener("conduit:save-vault", handleSaveVault);
    document.addEventListener("conduit:rename-vault", handleRenameVault);
    document.addEventListener("conduit:change-vault-password", handleChangeVaultPassword);
    document.addEventListener("conduit:device-setup", handleDeviceSetup);
    document.addEventListener("conduit:create-team-vault", handleCreateTeamVault);
    document.addEventListener("conduit:team-vault-unlock", handleTeamVaultUnlockEvent);
    document.addEventListener("conduit:vault-settings", handleVaultSettings);
    document.addEventListener("conduit:team-vault-members", handleVaultSettings);
    document.addEventListener("conduit:team-vault-audit", handleTeamVaultAudit);
    document.addEventListener("conduit:folder-permissions", handleFolderPermissions);

    // Listen for MCP-created sessions (agent opens connections via MCP)
    const unlistenMcpCreated = window.electron.on(
      "session:mcp-created",
      (payload: unknown) => {
        const data = payload as { sessionId: string; type: string; title: string };
        const store = useSessionStore.getState();
        // Don't duplicate if already in session store
        if (store.sessions.some((s) => s.id === data.sessionId)) return;
        store.addSession({
          id: data.sessionId,
          type: data.type as SessionType,
          title: data.title,
          status: "connected",
        });
      }
    );

    // Listen for terminal mid-session disconnects
    const unlistenTerminalStatus = window.electron.on("terminal:status", (payload: unknown) => {
      const data = payload as { sessionId: string; status: string; error: string | null };
      const store = useSessionStore.getState();
      const session = store.sessions.find(s => s.id === data.sessionId);
      if (!session) return;
      if (data.status === 'disconnected') {
        // Local shell clean exit → just close the tab
        if (session.type === 'local_shell' && !data.error) {
          store.removeSession(data.sessionId);
        } else {
          store.updateSessionStatus(data.sessionId, 'disconnected', data.error);
        }
      }
    });

    // Listen for VNC mid-session disconnects
    const unlistenVncStatus = window.electron.on("vnc:status", (payload: unknown) => {
      const data = payload as { sessionId: string; status: string; error: string | null };
      if (data.status === 'disconnected') {
        useSessionStore.getState().updateSessionStatus(data.sessionId, 'disconnected', data.error);
      }
    });

    // Listen for web session load failures
    const unlistenWebStatus = window.electron.on("web:status", (payload: unknown) => {
      const data = payload as { sessionId: string; status: string; error: string | null };
      if (data.status === 'disconnected') {
        // Hide the native WebContentsView so the HTML error overlay is visible
        invoke("web_session_hide", { sessionId: data.sessionId }).catch(() => {});
        useSessionStore.getState().updateSessionStatus(data.sessionId, 'disconnected', data.error);
      }
    });

    // Listen for team-sync events — reload entries/folders when reconcile or Realtime updates the local vault
    const unlistenEntriesRefreshed = window.electron.on("vault:entries-refreshed", () => {
      if (useVaultStore.getState().isUnlocked) {
        useEntryStore.getState().loadAll();
      }
    });
    const unlistenEntryChanged = window.electron.on("vault:entry-changed", () => {
      if (useVaultStore.getState().isUnlocked) {
        useEntryStore.getState().loadAll();
      }
    });
    const unlistenFolderChanged = window.electron.on("vault:folder-changed", () => {
      if (useVaultStore.getState().isUnlocked) {
        useEntryStore.getState().loadAll();
      }
    });

    // Listen for system-initiated vault lock (window hidden to tray/dock)
    const unlistenSystemLock = window.electron.on("vault-locked-by-system", () => {
      useVaultStore.getState().setLocked();
      useSessionStore.getState().clearAll();
      useEntryStore.getState().clearSelection();
      useEntryStore.setState({ entries: [], folders: [] });
      useLayoutStore.getState().resetLayout();
      useAiStore.getState().resetConversationState();
    });

    // The window opened again after a close that locked an automatically opened vault (spec 4.6)
    const unlistenStartupAgain = window.electron.on("vault-startup-again", () => {
      void runStartupVault();
    });
    const unlistenAutoUnlock = window.electron.on("auto-unlock-event", (payload: unknown) => {
      handleAutoUnlockEvent(payload);
    });

    // Listen for file association opens (.conduit files double-clicked while app is running)
    const unlistenOpenVaultFile = window.electron.on("open-vault-file", async (filePath: unknown) => {
      const fp = filePath as string;
      if (!fp?.endsWith(".conduit")) return;
      console.log("[App] File association received while running:", fp);
      const vaultState = useVaultStore.getState();
      await vaultState.openVault(fp);
      vaultState.setShowVaultHub(false);
      document.dispatchEvent(new CustomEvent("conduit:unlock-vault"));
    });

    // Listen for native menu actions from Electron main process
    const unlistenMenu = window.electron.on("menu-action", (action: unknown) => {
      const a = action as string;
      if (a === "new-vault") document.dispatchEvent(new CustomEvent("conduit:new-vault"));
      else if (a === "open-vault") document.dispatchEvent(new CustomEvent("conduit:open-vault"));
      else if (a === "new-entry") document.dispatchEvent(new CustomEvent("conduit:new-entry"));
      else if (a === "new-folder") document.dispatchEvent(new CustomEvent("conduit:new-folder"));
      else if (a === "lock-vault") document.dispatchEvent(new CustomEvent("conduit:lock-vault"));
      else if (a === "switch-vault") document.dispatchEvent(new CustomEvent("conduit:lock-vault"));
      else if (a === "settings") document.dispatchEvent(new CustomEvent("conduit:settings"));
      else if (a === "about") document.dispatchEvent(new CustomEvent("conduit:about"));
      else if (a === "replay-onboarding") document.dispatchEvent(new CustomEvent("conduit:replay-onboarding"));
      else if (a === "password-generator") document.dispatchEvent(new CustomEvent("conduit:password-generator"));
      else if (a === "ssh-key-generator") document.dispatchEvent(new CustomEvent("conduit:ssh-key-generator"));
      else if (a === "export-vault") document.dispatchEvent(new CustomEvent("conduit:export-vault"));
      else if (a === "import-export") document.dispatchEvent(new CustomEvent("conduit:import-export"));
      else if (a === "import-rdm") document.dispatchEvent(new CustomEvent("conduit:import-rdm"));
      else if (a === "save-vault") document.dispatchEvent(new CustomEvent("conduit:save-vault"));
      else if (a === "rename-vault") document.dispatchEvent(new CustomEvent("conduit:rename-vault"));
      else if (a === "change-vault-password") document.dispatchEvent(new CustomEvent("conduit:change-vault-password"));
      else if (a === "whats-new") document.dispatchEvent(new CustomEvent("conduit:whats-new"));
      else if (a === "submit-bug") setFeedbackType("bug");
      else if (a === "submit-feedback") setFeedbackType("feedback");
      else if (a === "check-for-updates") document.dispatchEvent(new CustomEvent("conduit:check-for-updates"));
      else if (a === "install-update") invoke("install_update").catch(console.error);
      else if (a === "sign-out") useAuthStore.getState().signOut();
      else if (a === "close-all-sessions") {
        useSessionStore.getState().clearAll();
        useLayoutStore.getState().resetLayout();
        toast.info("All sessions closed");
      }
      else if (a === "dev:test-toast") toast.success("Test toast notification", "Triggered from View menu");
    });

    // macOS refused Conduit's local network traffic at startup. Nothing on the
    // LAN will connect until the user flips the switch, and macOS will not ask
    // again on its own, so this stays until dismissed.
    const unlistenLocalNetwork = window.electron.on("local-network:blocked", (payload: unknown) => {
      const appName =
        payload && typeof payload === "object" && "appName" in payload && typeof payload.appName === "string"
          ? payload.appName
          : localNetworkSettingsAppName();
      toast.error("macOS is blocking local network access", {
        message: localNetworkPermissionMessage(appName),
        persistent: true,
        actions: [
          {
            label: "Open Settings",
            variant: "primary",
            onClick: () => invoke("open_local_network_settings").catch(console.error),
          },
        ],
      });
    });

    return () => {
      document.removeEventListener("conduit:replay-onboarding", handleReplayOnboarding);
      document.removeEventListener("conduit:whats-new", handleWhatsNew);
      if (handleDevOnboarding) document.removeEventListener("keydown", handleDevOnboarding);
      document.removeEventListener("conduit:about", handleAbout);
      document.removeEventListener("conduit:quick-connect", handleQuickConnect);
      document.removeEventListener("conduit:settings", handleSettings);
      document.removeEventListener("conduit:credentials", handleCredentials);
      document.removeEventListener("conduit:new-entry", handleNewEntry);
      document.removeEventListener("conduit:new-folder", handleNewFolder);
      document.removeEventListener("conduit:edit-entry", handleEditEntry);
      document.removeEventListener("conduit:edit-folder", handleEditFolder);
      document.removeEventListener("conduit:new-terminal", handleNewTerminal);
      document.removeEventListener("conduit:close-tab", handleCloseTab);
      document.removeEventListener("conduit:next-tab", handleNextTab);
      document.removeEventListener("conduit:prev-tab", handlePrevTab);
      document.removeEventListener("conduit:split-right", handleSplitRight);
      document.removeEventListener("conduit:split-down", handleSplitDown);
      document.removeEventListener("conduit:open-vault", handleOpenVault);
      document.removeEventListener("conduit:new-vault", handleNewVault);
      document.removeEventListener("conduit:lock-vault", handleLockVault);
      document.removeEventListener("conduit:unlock-vault", handleUnlockVault);
      document.removeEventListener("conduit:new-agent", handleNewAgentEvent);
      document.removeEventListener("conduit:password-generator", handlePasswordGenerator);
      document.removeEventListener("conduit:ssh-key-generator", handleSshKeyGenerator);
      document.removeEventListener("conduit:import-rdm", handleImportRdm);
      document.removeEventListener("conduit:export-vault", handleExportVault);
      document.removeEventListener("conduit:import-export", handleImportExport);
      document.removeEventListener("conduit:save-vault", handleSaveVault);
      document.removeEventListener("conduit:rename-vault", handleRenameVault);
      document.removeEventListener("conduit:change-vault-password", handleChangeVaultPassword);
      document.removeEventListener("conduit:device-setup", handleDeviceSetup);
      document.removeEventListener("conduit:create-team-vault", handleCreateTeamVault);
      document.removeEventListener("conduit:team-vault-unlock", handleTeamVaultUnlockEvent);
      document.removeEventListener("conduit:vault-settings", handleVaultSettings);
      document.removeEventListener("conduit:team-vault-members", handleVaultSettings);
      document.removeEventListener("conduit:team-vault-audit", handleTeamVaultAudit);
      document.removeEventListener("conduit:folder-permissions", handleFolderPermissions);
      unlistenMcpCreated();
      unlistenTerminalStatus();
      unlistenVncStatus();
      unlistenWebStatus();
      unlistenEntriesRefreshed();
      unlistenEntryChanged();
      unlistenFolderChanged();
      unlistenSystemLock();
      unlistenStartupAgain();
      unlistenAutoUnlock();
      unlistenOpenVaultFile();
      unlistenMenu();
      unlistenLocalNetwork();
    };
  }, []);

  // One NotificationStack for every screen, so a toast raised on one screen survives the switch to the next.
  const renderScreen = () => {
    // Auth loading state
    if (isInitializing) {
      return <FullScreenSpinner text="Loading..." />;
    }

    // Auth gate — allow local and cached modes to bypass sign-in
    if (!isAuthenticated && authMode !== 'local' && authMode !== 'cached') {
      return <AuthScreen />;
    }

    // Onboarding gate — show wizard for first-time authenticated users
    if (showOnboarding) {
      return <OnboardingWizard onComplete={() => setShowOnboarding(false)} />;
    }

    // The startup vault opening (spec 2.3): automatic unlock, or a team vault chosen in Settings
    if (startupOpening) {
      return (
        <FullScreenSpinner
          text={startupOpening.text}
          onGoToHub={startupOpening.cancellable ? goToVaultHubFromStartup : undefined}
        />
      );
    }

    // Full-screen auto-connect spinner (team vault auto-connect in progress)
    if (autoConnectInProgress) {
      return <FullScreenSpinner text="Connecting to team vault..." />;
    }

    // Sign-in settled; the startup routine has not decided yet
    if (startupPending) {
      return <FullScreenSpinner text="Loading..." />;
    }

    // Vault Hub — full-screen landing page (stays until explicitly dismissed)
    if (showVaultHub) {
      return (
        <div className="flex flex-col h-screen bg-editor text-ink">
          {authMode === 'cached' && <OfflineBanner />}
          <VaultHub />
          {/* Overlay dialogs that can appear on top of hub */}
          {showUnlockDialog && (
            <UnlockDialog
              onSuccess={() => {
                setShowUnlockDialog(false);
                useVaultStore.getState().setShowVaultHub(false);
                useEntryStore.getState().loadAll();
              }}
              onCancel={() => {
                setShowUnlockDialog(false);
              }}
            />
          )}
          {showCloudRestore && (
            <CloudRestoreDialog
              onRestore={() => {
                setShowCloudRestore(false);
                useVaultStore.getState().setShowVaultHub(false);
                useEntryStore.getState().loadAll();
              }}
              onCreateNew={() => {
                setShowCloudRestore(false);
                useVaultStore.getState().clearError();
                setShowUnlockDialog(true);
              }}
            />
          )}
          {teamVaultToUnlock && (
            <TeamVaultUnlock
              teamVaultId={teamVaultToUnlock.id}
              vaultName={teamVaultToUnlock.name}
              onSuccess={() => {
                setTeamVaultToUnlock(null);
                useVaultStore.getState().setShowVaultHub(false);
                useEntryStore.getState().loadAll();
              }}
              onCancel={() => setTeamVaultToUnlock(null)}
            />
          )}
          {showDeviceSetup && (
            <DeviceSetupDialog
              onComplete={() => {
                setShowDeviceSetup(false);
                useTeamStore.getState().loadTeamVaults();
              }}
              onSkip={() => setShowDeviceSetup(false)}
            />
          )}
          <SyncLayer />
        </div>
      );
    }

    return (
      <div className="flex flex-col h-screen bg-editor text-ink">
        <div data-cv-accent-line className="h-[2px] shrink-0 bg-accent" />
        {authMode === 'cached' && <OfflineBanner />}
        <SyncBanners />
        <div className="flex flex-1 min-h-0">
        {/* Sidebar — docked in this row when pinned, otherwise a fixed overlay */}
        <Sidebar />
        {/* Main Area */}
        <div className="flex flex-col flex-1 min-w-0">
          {/* Content Area */}
          <div className="flex flex-1 min-h-0">
            <SplitContainer
              rightSlot={
                <IconButton
                  data-cv-ai-toggle=""
                  icon="robot"
                  label="Toggle AI Panel"
                  pressed={showAiPanel}
                  className="mr-1"
                  onClick={() => setShowAiPanel(!showAiPanel)}
                />
              }
            />
            {/* AI side panel */}
            <>
              <div
                data-cv-ai-divider=""
                data-dragging={aiDragging ? "" : undefined}
                onMouseDown={handleAiResizeStart}
                className="cv-sash cv-sash-ai"
                style={{ display: showAiPanel ? undefined : 'none' }}
              />
              <div
                data-cv-ai-panel=""
                className="shrink-0 overflow-hidden"
                style={{
                  width: aiPanelWidth,
                  display: showAiPanel ? undefined : 'none',
                  contain: 'strict',
                }}
              >
                <ChatPanel />
              </div>
            </>
          </div>
        </div>
        </div>

        {/* Startup status bar (background builds, setup tasks) */}
        <StartupStatus />

        {/* Modals */}
        {showQuickConnect && (
          <QuickConnect onClose={() => setShowQuickConnect(false)} />
        )}
        {showSettings !== false && (
          <SettingsDialog
            initialTab={showSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
        {showCredentials && (
          <CredentialManager onClose={() => setShowCredentials(false)} />
        )}
        {showEntryDialog && (
          <EntryDialog
            folderId={newEntryFolderId}
            onClose={closeNewEntryDialog}
          />
        )}
        {editingEntryId && (
          <EntryDialog
            editingEntryId={editingEntryId}
            onClose={closeEditingEntry}
          />
        )}
        {showFolderDialog && (
          <FolderDialog
            parentId={newFolderParentId}
            onClose={() => {
              setShowFolderDialog(false);
              setNewFolderParentId(null);
            }}
          />
        )}
        {editingFolderId && (
          <FolderDialog
            editingFolderId={editingFolderId}
            onClose={() => setEditingFolderId(null)}
          />
        )}
        {showUnlockDialog && (
          <UnlockDialog
            onSuccess={() => {
              setShowUnlockDialog(false);
              useVaultStore.getState().setShowVaultHub(false);
              useEntryStore.getState().loadAll();
            }}
            onCancel={() => {
              setShowUnlockDialog(false);
            }}
          />
        )}
        {showCloudRestore && (
          <CloudRestoreDialog
            onRestore={() => {
              setShowCloudRestore(false);
              useVaultStore.getState().setShowVaultHub(false);
              useEntryStore.getState().loadAll();
            }}
            onCreateNew={() => {
              setShowCloudRestore(false);
              useVaultStore.getState().clearError();
              setShowUnlockDialog(true);
            }}
          />
        )}

        {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
        {showWhatsNew && (
          <WhatsNewDialog
            initialVersion={whatsNewVersion}
            onClose={async () => {
              setShowWhatsNew(false);
              // Save current version as last_seen_whats_new_version
              try {
                const version = await invoke<string>('app_get_version');
                const settings = await invoke<Record<string, unknown>>('settings_get');
                await invoke('settings_save', {
                  settings: { ...settings, last_seen_whats_new_version: version },
                });
              } catch {
                // Best-effort save
              }
            }}
          />
        )}
        {showPasswordGenerator && (
          <PasswordGeneratorDialog onClose={() => setShowPasswordGenerator(false)} />
        )}
        {showSshKeyGenerator && (
          <SshKeyGeneratorDialog onClose={() => setShowSshKeyGenerator(false)} />
        )}
        {showImportDialog && (
          <ImportDialog
            onClose={() => {
              setShowImportDialog(false);
              useEntryStore.getState().loadAll();
            }}
          />
        )}
        {showExportDialog && (
          <ExportDialog onClose={() => setShowExportDialog(false)} />
        )}
        {showVaultImportDialog && (
          <VaultImportDialog
            onClose={() => {
              setShowVaultImportDialog(false);
              useEntryStore.getState().loadAll();
            }}
          />
        )}

        {showRenameVaultDialog && (
          <RenameVaultDialog onClose={() => setShowRenameVaultDialog(false)} />
        )}

        {showChangePasswordDialog && (
          <ChangePasswordDialog onClose={() => setShowChangePasswordDialog(false)} />
        )}

        {/* Feedback / Bug report dialog */}
        {feedbackType && (
          <FeedbackDialog type={feedbackType} onClose={() => setFeedbackType(null)} />
        )}

        {/* Device setup for team vaults */}
        {showDeviceSetup && (
          <DeviceSetupDialog
            onComplete={() => {
              setShowDeviceSetup(false);
              useTeamStore.getState().loadTeamVaults();
            }}
            onSkip={() => setShowDeviceSetup(false)}
          />
        )}

        {/* Create team vault */}
        {showCreateTeamVault && (
          <CreateTeamVaultDialog
            onClose={() => setShowCreateTeamVault(false)}
          />
        )}

        {/* Team vault unlock */}
        {teamVaultToUnlock && (
          <TeamVaultUnlock
            teamVaultId={teamVaultToUnlock.id}
            vaultName={teamVaultToUnlock.name}
            onSuccess={() => {
              setTeamVaultToUnlock(null);
              useEntryStore.getState().loadAll();
            }}
            onCancel={() => setTeamVaultToUnlock(null)}
          />
        )}

        {/* Vault settings (members + folder permissions) */}
        {showVaultSettings && (
          <VaultSettingsDialog
            initialTab={showVaultSettings.tab}
            initialFolderId={showVaultSettings.folderId}
            onClose={() => setShowVaultSettings(false)}
          />
        )}

        {/* Device authorization approval */}
        {pendingDeviceAuth && (
          <DeviceAuthApprovalDialog
            requestId={pendingDeviceAuth.id}
            deviceName={pendingDeviceAuth.requesting_device_name}
            onClose={() => setPendingDeviceAuth(null)}
          />
        )}

        <SyncLayer />
      </div>
    );
  };

  return (
    <>
      {renderScreen()}
      <StartupConfirmHost />
      <NotificationStack />
    </>
  );
}

export default App;
