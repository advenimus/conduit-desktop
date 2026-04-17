import { create } from "zustand";
import { invoke } from "../lib/electron";
import type { CredentialMeta, CredentialDto } from "../types/credential";
import { useTeamStore } from "./teamStore";
import { useEntryStore } from "./entryStore";
import { useSessionStore } from "./sessionStore";
import { useLayoutStore } from "./layoutStore";

export interface CloudSyncState {
  status: "idle" | "syncing" | "synced" | "error" | "disabled";
  lastSyncedAt: string | null;
  error: string | null;
  enabled: boolean;
}

export interface CloudBackupEntry {
  name: string;
  path: string;
  created_at: string;
  size: number;
  vaultId: string;
  vaultName: string;
}

export interface LocalBackupState {
  status: "idle" | "backing-up" | "backed-up" | "error" | "disabled";
  lastBackedUpAt: string | null;
  error: string | null;
  enabled: boolean;
  backupPath: string | null;
  retentionDays: number;
  includeChat: boolean;
}

export interface LocalBackupEntry {
  name: string;
  fullPath: string;
  created_at: string;
  size: number;
  type: "vault" | "chat";
}

export type TeamSyncStatus = "idle" | "syncing" | "synced" | "error" | "offline" | "disconnected";

export interface TeamSyncState {
  status: TeamSyncStatus;
  lastSyncedAt: string | null;
  error: string | null;
  pendingChanges: number;
}

interface VaultState {
  isUnlocked: boolean;
  vaultExists: boolean;
  credentials: CredentialMeta[];
  isLoading: boolean;
  error: string | null;
  currentVaultPath: string | null;
  recentVaults: string[];
  cloudSyncState: CloudSyncState | null;
  cloudVaultExists: boolean | null;
  cloudBackups: CloudBackupEntry[];
  cloudBackupRetentionDays: number | null;
  loadingBackups: boolean;

  // Local backup
  localBackupState: LocalBackupState | null;
  localBackups: LocalBackupEntry[];
  loadingLocalBackups: boolean;

  // Network vault detection
  isNetworkVault: boolean;

  // Team vault
  vaultType: "personal" | "team";
  teamVaultId: string | null;
  teamSyncState: TeamSyncState | null;
  syncFailures: number;

  // Vault Hub
  showVaultHub: boolean;
  autoConnectInProgress: boolean;
  autoConnectError: string | null;

  // Biometric unlock (Touch ID / Windows Hello)
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  biometricUnlockInProgress: boolean;

  // Vault lifecycle
  checkVaultStatus: () => Promise<void>;
  initializeVault: (masterPassword: string) => Promise<void>;
  unlockVault: (masterPassword: string) => Promise<void>;
  lockVault: () => Promise<void>;
  /** Mark vault as locked locally (backend already locked). */
  setLocked: () => void;

  // Vault management
  createVault: (filePath: string, masterPassword: string) => Promise<void>;
  openVault: (filePath: string) => Promise<void>;
  pickVaultFile: (mode: "open" | "save") => Promise<string | null>;

  // Credential actions (legacy compat)
  loadCredentials: () => Promise<void>;
  getCredential: (id: string) => Promise<CredentialDto>;
  createCredential: (params: {
    name: string;
    username?: string;
    password?: string;
    domain?: string;
    privateKey?: string;
    totpSecret?: string | null;
    tags: string[];
    credentialType?: string;
    publicKey?: string;
    fingerprint?: string;
    totpIssuer?: string | null;
    totpLabel?: string | null;
    totpAlgorithm?: string | null;
    totpDigits?: number | null;
    totpPeriod?: number | null;
    sshAuthMethod?: string | null;
  }) => Promise<CredentialMeta>;
  updateCredential: (
    id: string,
    params: {
      name?: string;
      username?: string | null;
      password?: string | null;
      domain?: string | null;
      privateKey?: string | null;
      totpSecret?: string | null;
      tags?: string[];
      credentialType?: string;
      publicKey?: string;
      fingerprint?: string;
      totpIssuer?: string | null;
      totpLabel?: string | null;
      totpAlgorithm?: string | null;
      totpDigits?: number | null;
      totpPeriod?: number | null;
      sshAuthMethod?: string | null;
    }
  ) => Promise<CredentialMeta>;
  deleteCredential: (id: string) => Promise<void>;
  clearError: () => void;

  // Manual save
  isSaving: boolean;
  saveVault: () => Promise<void>;

  // Cloud sync
  checkCloudVault: () => Promise<boolean>;
  enableCloudSync: () => Promise<void>;
  disableCloudSync: () => Promise<void>;
  syncNow: () => Promise<void>;
  restoreFromCloud: (masterPassword: string) => Promise<void>;
  deleteCloudVault: () => Promise<void>;
  setCloudSyncState: (state: CloudSyncState) => void;
  fetchCloudSyncState: () => Promise<void>;

  // Cloud backup history
  listCloudBackups: () => Promise<void>;
  restoreFromBackup: (storagePath: string, masterPassword: string, vaultName?: string) => Promise<void>;
  getCloudBackupRetention: () => Promise<void>;

  // Local backup
  fetchLocalBackupState: () => Promise<void>;
  setLocalBackupState: (state: LocalBackupState) => void;
  enableLocalBackup: (backupPath: string) => Promise<void>;
  disableLocalBackup: () => Promise<void>;
  localBackupNow: () => Promise<void>;
  listLocalBackups: () => Promise<void>;
  deleteLocalBackup: (fullPath: string) => Promise<void>;
  updateLocalBackupSettings: (opts: { retentionDays?: number; includeChat?: boolean }) => Promise<void>;
  selectLocalBackupFolder: () => Promise<string | null>;

  // Team vault
  openTeamVault: (teamVaultId: string) => Promise<void>;
  closeTeamVault: () => Promise<void>;
  teamSyncNow: () => Promise<void>;
  fetchTeamSyncState: () => Promise<void>;
  setSyncFailures: (count: number) => void;
  setTeamSyncState: (state: TeamSyncState) => void;

  // Recent vaults management
  removeRecentVault: (vaultPath: string) => Promise<void>;
  clearRecentVaults: () => Promise<void>;

  // Vault Hub
  setShowVaultHub: (show: boolean) => void;
  setAutoConnectInProgress: (inProgress: boolean) => void;
  setAutoConnectError: (error: string | null) => void;
  returnToHub: () => void;

  // Biometric unlock
  checkBiometric: () => Promise<void>;
  enableBiometric: () => Promise<void>;
  disableBiometric: () => Promise<void>;
  biometricUnlock: () => Promise<void>;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  isUnlocked: false,
  vaultExists: false,
  credentials: [],
  isLoading: false,
  error: null,
  currentVaultPath: null,
  recentVaults: [],
  cloudSyncState: null,
  cloudVaultExists: null,
  cloudBackups: [],
  cloudBackupRetentionDays: null,
  loadingBackups: false,
  localBackupState: null,
  localBackups: [],
  loadingLocalBackups: false,
  isNetworkVault: false,
  isSaving: false,
  vaultType: "personal",
  teamVaultId: null,
  teamSyncState: null,
  syncFailures: 0,
  showVaultHub: true,
  autoConnectInProgress: false,
  autoConnectError: null,
  biometricAvailable: false,
  biometricEnabled: false,
  biometricUnlockInProgress: false,

  checkVaultStatus: async () => {
    try {
      const [exists, unlocked, vaultPath, settings] = await Promise.all([
        invoke<boolean>("vault_exists"),
        invoke<boolean>("vault_is_unlocked"),
        invoke<string>("vault_get_path"),
        invoke<{ recent_vaults?: string[] }>("settings_get"),
      ]);
      set({
        vaultExists: exists,
        isUnlocked: unlocked,
        currentVaultPath: vaultPath,
        recentVaults: settings.recent_vaults ?? [],
      });
      if (unlocked) {
        await get().loadCredentials();
      }
      // Check biometric availability for current vault
      await get().checkBiometric();
    } catch (err) {
      console.error("Failed to check vault status:", err);
    }
  },

  initializeVault: async (masterPassword: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("vault_initialize", { masterPassword });
      set({ isUnlocked: true, vaultExists: true, isLoading: false });
      await get().loadCredentials();
    } catch (err) {
      set({
        isLoading: false,
        error: typeof err === "string" ? err : "Failed to initialize vault",
      });
      throw err;
    }
  },

  unlockVault: async (masterPassword: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("vault_unlock", { masterPassword });
      set({ isUnlocked: true, isLoading: false });
      await get().loadCredentials();
    } catch (err) {
      set({
        isLoading: false,
        error: typeof err === "string" ? err : "Invalid master password",
      });
      throw err;
    }
  },

  lockVault: async () => {
    try {
      await invoke("vault_lock");
      useSessionStore.getState().clearAll();
      useEntryStore.getState().clearSelection();
      useLayoutStore.getState().resetLayout();
      set({ isUnlocked: false, credentials: [], showVaultHub: true });
    } catch (err) {
      console.error("Failed to lock vault:", err);
    }
  },

  setLocked: () => {
    set({ isUnlocked: false, credentials: [], showVaultHub: true });
  },

  createVault: async (filePath: string, masterPassword: string) => {
    set({ isLoading: true, error: null });
    try {
      const resultPath = await invoke<string>("vault_create", { filePath, masterPassword });
      useSessionStore.getState().clearAll();
      useEntryStore.getState().clearSelection();
      useLayoutStore.getState().resetLayout();
      const settings = await invoke<{ recent_vaults?: string[] }>("settings_get");
      set({
        isLoading: false,
        isUnlocked: true,
        vaultExists: true,
        currentVaultPath: resultPath,
        credentials: [],
        recentVaults: settings.recent_vaults ?? [],
      });
    } catch (err) {
      set({
        isLoading: false,
        error: typeof err === "string" ? err : "Failed to create vault",
      });
      throw err;
    }
  },

  openVault: async (filePath: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await invoke<{ filePath: string; exists: boolean }>("vault_open", { filePath });
      const resultPath = result.filePath;
      const exists = result.exists;
      useSessionStore.getState().clearAll();
      useEntryStore.getState().clearSelection();
      useLayoutStore.getState().resetLayout();
      const settings = await invoke<{ recent_vaults?: string[] }>("settings_get");
      // Check if this is a network vault
      let isNetwork = false;
      try {
        isNetwork = await invoke<boolean>("vault_is_network_path", { filePath: resultPath });
      } catch { /* ignore — IPC may not exist */ }

      set({
        isLoading: false,
        isUnlocked: false,
        vaultExists: exists,
        currentVaultPath: resultPath,
        credentials: [],
        recentVaults: settings.recent_vaults ?? [],
        isNetworkVault: isNetwork,
      });
      // Check biometric availability for newly opened vault
      await get().checkBiometric();
    } catch (err) {
      set({
        isLoading: false,
        error: typeof err === "string" ? err : "Failed to open vault",
      });
      throw err;
    }
  },

  pickVaultFile: async (mode: "open" | "save") => {
    try {
      return await invoke<string | null>("vault_pick_file", { mode });
    } catch (err) {
      console.error("Failed to pick vault file:", err);
      return null;
    }
  },

  loadCredentials: async () => {
    try {
      const credentials = await invoke<CredentialMeta[]>("credential_list");
      set({ credentials });
    } catch (err) {
      console.error("Failed to load credentials:", err);
    }
  },

  getCredential: async (id: string) => {
    return await invoke<CredentialDto>("credential_get", { id });
  },

  createCredential: async (params) => {
    set({ error: null });
    try {
      const credential = await invoke<CredentialMeta>("credential_create", {
        name: params.name,
        username: params.username || null,
        password: params.password || null,
        domain: params.domain || null,
        private_key: params.privateKey || null,
        totp_secret: params.totpSecret || null,
        tags: params.tags,
        credential_type: params.credentialType || null,
        public_key: params.publicKey || null,
        fingerprint: params.fingerprint || null,
        totp_issuer: params.totpIssuer || null,
        totp_label: params.totpLabel || null,
        totp_algorithm: params.totpAlgorithm || null,
        totp_digits: params.totpDigits || null,
        totp_period: params.totpPeriod || null,
        ssh_auth_method: params.sshAuthMethod || null,
      });
      await get().loadCredentials();
      // Credentials are entries — refresh the entry tree so the sidebar updates
      useEntryStore.getState().loadAll();
      return credential;
    } catch (err) {
      const msg =
        typeof err === "string" ? err : "Failed to create credential";
      set({ error: msg });
      throw err;
    }
  },

  updateCredential: async (id, params) => {
    set({ error: null });
    try {
      const credential = await invoke<CredentialMeta>("credential_update", {
        id,
        name: params.name,
        username: params.username !== undefined ? params.username : undefined,
        password: params.password !== undefined ? params.password : undefined,
        domain: params.domain !== undefined ? params.domain : undefined,
        private_key:
          params.privateKey !== undefined ? params.privateKey : undefined,
        totp_secret:
          params.totpSecret !== undefined ? params.totpSecret : undefined,
        tags: params.tags,
        credential_type: params.credentialType,
        public_key: params.publicKey,
        fingerprint: params.fingerprint,
        totp_issuer:
          params.totpIssuer !== undefined ? params.totpIssuer : undefined,
        totp_label:
          params.totpLabel !== undefined ? params.totpLabel : undefined,
        totp_algorithm:
          params.totpAlgorithm !== undefined ? params.totpAlgorithm : undefined,
        totp_digits:
          params.totpDigits !== undefined ? params.totpDigits : undefined,
        totp_period:
          params.totpPeriod !== undefined ? params.totpPeriod : undefined,
        ssh_auth_method:
          params.sshAuthMethod !== undefined ? params.sshAuthMethod : undefined,
      });
      await get().loadCredentials();
      return credential;
    } catch (err) {
      const msg =
        typeof err === "string" ? err : "Failed to update credential";
      set({ error: msg });
      throw err;
    }
  },

  deleteCredential: async (id: string) => {
    set({ error: null });
    try {
      await invoke("credential_delete", { id });
      await get().loadCredentials();
    } catch (err) {
      const msg =
        typeof err === "string" ? err : "Failed to delete credential";
      set({ error: msg });
      throw err;
    }
  },

  clearError: () => set({ error: null }),

  // ── Manual save ─────────────────────────────────────────────

  saveVault: async () => {
    set({ isSaving: true });
    try {
      await invoke("vault_save");
    } catch (err) {
      console.error("Failed to save vault:", err);
      throw err;
    } finally {
      set({ isSaving: false });
    }
  },

  // ── Cloud sync ──────────────────────────────────────────────

  checkCloudVault: async () => {
    try {
      const exists = await invoke<boolean>("cloud_vault_exists");
      set({ cloudVaultExists: exists });
      return exists;
    } catch (err) {
      console.error("Failed to check cloud vault:", err);
      set({ cloudVaultExists: false });
      return false;
    }
  },

  enableCloudSync: async () => {
    try {
      await invoke("cloud_sync_enable");
      await get().fetchCloudSyncState();
    } catch (err) {
      console.error("Failed to enable cloud sync:", err);
      throw err;
    }
  },

  disableCloudSync: async () => {
    try {
      await invoke("cloud_sync_disable");
      set({ cloudSyncState: { status: "disabled", lastSyncedAt: null, error: null, enabled: false } });
    } catch (err) {
      console.error("Failed to disable cloud sync:", err);
      throw err;
    }
  },

  syncNow: async () => {
    try {
      await invoke("cloud_sync_now");
      await get().fetchCloudSyncState();
    } catch (err) {
      console.error("Failed to sync:", err);
      throw err;
    }
  },

  restoreFromCloud: async (masterPassword: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("cloud_vault_restore", { masterPassword });
      set({ isUnlocked: true, vaultExists: true, isLoading: false });
      await get().loadCredentials();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Failed to restore vault from cloud";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  deleteCloudVault: async () => {
    try {
      await invoke("cloud_vault_delete");
      set({ cloudVaultExists: false });
    } catch (err) {
      console.error("Failed to delete cloud vault:", err);
      throw err;
    }
  },

  setCloudSyncState: (state: CloudSyncState) => {
    set({ cloudSyncState: state });
  },

  fetchCloudSyncState: async () => {
    try {
      const state = await invoke<CloudSyncState>("cloud_sync_get_state");
      set({ cloudSyncState: state });
    } catch (err) {
      console.error("Failed to fetch cloud sync state:", err);
    }
  },

  // ── Cloud backup history ──────────────────────────────────

  listCloudBackups: async () => {
    set({ loadingBackups: true });
    try {
      const backups = await invoke<CloudBackupEntry[]>("cloud_backup_list_all");
      set({ cloudBackups: backups, loadingBackups: false });
    } catch (err) {
      console.error("Failed to list cloud backups:", err);
      set({ cloudBackups: [], loadingBackups: false });
    }
  },

  restoreFromBackup: async (storagePath: string, masterPassword: string, vaultName?: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("cloud_backup_restore", { storagePath, masterPassword, vaultName });
      set({ isUnlocked: true, vaultExists: true, isLoading: false });
      await get().loadCredentials();
    } catch (err) {
      const msg = typeof err === "string" ? err : "Failed to restore from backup";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  getCloudBackupRetention: async () => {
    try {
      const limit = await invoke<number>("cloud_backup_get_retention");
      set({ cloudBackupRetentionDays: limit });
    } catch (err) {
      console.error("Failed to get cloud backup limit:", err);
    }
  },

  // ── Local backup ──────────────────────────────────────────────

  fetchLocalBackupState: async () => {
    try {
      const state = await invoke<LocalBackupState>("local_backup_get_state");
      set({ localBackupState: state });
    } catch (err) {
      console.error("Failed to fetch local backup state:", err);
    }
  },

  setLocalBackupState: (state: LocalBackupState) => {
    set({ localBackupState: state });
  },

  enableLocalBackup: async (backupPath: string) => {
    try {
      await invoke("local_backup_enable", { backupPath });
      await get().fetchLocalBackupState();
      await get().listLocalBackups();
    } catch (err) {
      console.error("Failed to enable local backup:", err);
      throw err;
    }
  },

  disableLocalBackup: async () => {
    try {
      await invoke("local_backup_disable");
      set({
        localBackupState: {
          status: "disabled",
          lastBackedUpAt: null,
          error: null,
          enabled: false,
          backupPath: null,
          retentionDays: 30,
          includeChat: true,
        },
      });
    } catch (err) {
      console.error("Failed to disable local backup:", err);
      throw err;
    }
  },

  localBackupNow: async () => {
    try {
      await invoke("local_backup_now");
      await get().fetchLocalBackupState();
      await get().listLocalBackups();
    } catch (err) {
      console.error("Failed to run local backup:", err);
      throw err;
    }
  },

  listLocalBackups: async () => {
    set({ loadingLocalBackups: true });
    try {
      const backups = await invoke<LocalBackupEntry[]>("local_backup_list");
      set({ localBackups: backups, loadingLocalBackups: false });
    } catch (err) {
      console.error("Failed to list local backups:", err);
      set({ localBackups: [], loadingLocalBackups: false });
    }
  },

  deleteLocalBackup: async (fullPath: string) => {
    try {
      await invoke("local_backup_delete", { fullPath });
      await get().listLocalBackups();
    } catch (err) {
      console.error("Failed to delete local backup:", err);
      throw err;
    }
  },

  updateLocalBackupSettings: async (opts) => {
    try {
      await invoke("local_backup_update_settings", opts);
      await get().fetchLocalBackupState();
    } catch (err) {
      console.error("Failed to update local backup settings:", err);
      throw err;
    }
  },

  selectLocalBackupFolder: async () => {
    try {
      return await invoke<string | null>("local_backup_select_folder");
    } catch (err) {
      console.error("Failed to select backup folder:", err);
      return null;
    }
  },

  // ── Team vault ──────────────────────────────────────────────

  openTeamVault: async (teamVaultId: string) => {
    set({ isLoading: true, error: null });
    try {
      await invoke("team_vault_open", { teamVaultId });
      useSessionStore.getState().clearAll();
      useEntryStore.getState().clearSelection();
      useLayoutStore.getState().resetLayout();
      set({
        isUnlocked: true,
        vaultType: "team",
        teamVaultId,
        isLoading: false,
        isNetworkVault: false,
      });
      await get().loadCredentials();
      // Refresh team vault list (member counts may have changed via auto-enrollment)
      await useTeamStore.getState().loadTeamVaults();
      // Load permission state for the active team vault
      await useTeamStore.getState().loadMyVaultRole(teamVaultId);
      await useTeamStore.getState().loadFolderPermissions(teamVaultId);
    } catch (err) {
      const msg = typeof err === "string" ? err : "Failed to open team vault";
      set({ isLoading: false, error: msg });
      throw err;
    }
  },

  closeTeamVault: async () => {
    try {
      await invoke("team_vault_close");
      useSessionStore.getState().clearAll();
      useEntryStore.getState().clearSelection();
      useLayoutStore.getState().resetLayout();
      set({
        isUnlocked: false,
        vaultType: "personal",
        teamVaultId: null,
        teamSyncState: null,
        syncFailures: 0,
        credentials: [],
        showVaultHub: true,
      });
      // Clear permission state
      useTeamStore.setState({
        myVaultRole: null,
        folderPermissions: new Map(),
        permissionsUnconfigured: true,
      });
      // Clear AI conversation state
      const { useAiStore } = await import("./aiStore");
      useAiStore.getState().resetConversationState();
    } catch (err) {
      console.error("Failed to close team vault:", err);
    }
  },

  teamSyncNow: async () => {
    try {
      await invoke("team_vault_sync_now");
      await get().fetchTeamSyncState();
    } catch (err) {
      console.error("Failed to sync team vault:", err);
      throw err;
    }
  },

  fetchTeamSyncState: async () => {
    try {
      const state = await invoke<TeamSyncState>("team_vault_sync_state");
      set({ teamSyncState: state });
    } catch (err) {
      console.error("Failed to fetch team sync state:", err);
    }
  },

  setSyncFailures: (count: number) => {
    set({ syncFailures: count });
  },

  setTeamSyncState: (state: TeamSyncState) => {
    const prev = get().teamSyncState;
    set({ teamSyncState: state });
    // Refresh team vault metadata (member counts, etc.) when a sync completes
    if (state.status === 'synced' && prev?.status !== 'synced') {
      useTeamStore.getState().loadTeamVaults().catch(() => {});
    }
  },

  // ── Vault Hub ──────────────────────────────────────────────

  setShowVaultHub: (show: boolean) => {
    set({ showVaultHub: show });
  },

  setAutoConnectInProgress: (inProgress: boolean) => {
    set({ autoConnectInProgress: inProgress });
  },

  setAutoConnectError: (error: string | null) => {
    set({ autoConnectError: error });
  },

  removeRecentVault: async (vaultPath: string) => {
    const updated = await invoke<string[]>("settings_remove_recent_vault", { vaultPath });
    set({ recentVaults: updated });
  },

  clearRecentVaults: async () => {
    await invoke("settings_clear_recent_vaults");
    set({ recentVaults: [] });
  },

  returnToHub: () => {
    set({
      showVaultHub: true,
      autoConnectInProgress: false,
      autoConnectError: null,
    });
  },

  // ── Biometric unlock ────────────────────────────────────────────

  checkBiometric: async () => {
    try {
      const available = await invoke<boolean>("biometric_available");
      const enabled = available
        ? await invoke<boolean>("biometric_enabled")
        : false;
      set({ biometricAvailable: available, biometricEnabled: enabled });
    } catch {
      set({ biometricAvailable: false, biometricEnabled: false });
    }
  },

  enableBiometric: async () => {
    await invoke("biometric_enable");
    set({ biometricEnabled: true });
  },

  disableBiometric: async () => {
    await invoke("biometric_disable");
    set({ biometricEnabled: false });
  },

  biometricUnlock: async () => {
    set({ biometricUnlockInProgress: true, error: null });
    try {
      await invoke("biometric_unlock");
      set({ isUnlocked: true, biometricUnlockInProgress: false });
      await get().loadCredentials();
    } catch (err) {
      set({ biometricUnlockInProgress: false });
      throw err;
    }
  },
}));
