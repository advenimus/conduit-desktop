import { create } from "zustand";
import { invoke } from "../lib/electron";
import type { EntryMeta, EntryFull, FolderData, ResolvedCredential, EntryType, RdpEntryConfig, WebEntryConfig } from "../types/entry";
import { useSessionStore } from "./sessionStore";
import { useSettingsStore } from "./settingsStore";
import { useVaultStore } from "./vaultStore";
import { useSidebarStore } from "./sidebarStore";
import { useAuthStore } from "./authStore";
import { useTierStore } from "./tierStore";
import { resolveRdpConfig, resolveWebConfig } from "../lib/resolveConfig";
import { toast } from "../components/common/Toast";
import { disposeTerminalEntry } from "../components/sessions/TerminalView";

/**
 * Map UI quality setting to RDP performance mode.
 * - best: Minimal performance optimizations (wallpaper disabled only)
 * - good: Balanced (wallpaper, window drag, animations disabled)
 * - low: Maximum performance (all visual effects disabled)
 */
function mapQualityToPerformanceMode(quality: "best" | "good" | "low"): "best" | "balanced" | "fast" {
  switch (quality) {
    case "best": return "best";
    case "good": return "balanced";
    case "low": return "fast";
  }
}

/**
 * Compute RDP connection dimensions and DPI scale factors.
 *
 * When enableHighDpi is set and the display has a devicePixelRatio > 1,
 * "match_window" mode sends physical pixel dimensions (e.g., 2560x1600 on
 * a 2x Retina display) and tells the RDP server the client's DPI. For
 * fixed/custom resolutions, only the scale factor is set (resolution unchanged).
 */
function computeRdpDimensions(rdpCfg: RdpEntryConfig, contentEl: Element | null): {
  width: number;
  height: number;
  desktopScaleFactor: number;
  deviceScaleFactor: number;
  effectiveHighDpi: boolean;
} {
  const dpr = window.devicePixelRatio || 1;
  // Auto-detect: enable HiDPI on Retina displays unless explicitly disabled
  const enableHighDpi = rdpCfg.enableHighDpi !== false && dpr > 1;

  let w: number, h: number;
  if (rdpCfg.resolution === "match_window") {
    w = contentEl?.clientWidth ?? (window.innerWidth - 250);
    h = contentEl?.clientHeight ?? (window.innerHeight - 40);

    // On HiDPI displays, send physical pixel dimensions for sharp rendering
    if (enableHighDpi && dpr > 1) {
      w = Math.round(w * dpr);
      h = Math.round(h * dpr);
    }
  } else if (rdpCfg.resolution === "custom") {
    w = rdpCfg.customWidth ?? 1920;
    h = rdpCfg.customHeight ?? 1080;
  } else {
    const [pw, ph] = rdpCfg.resolution.split("x").map(Number);
    w = pw;
    h = ph;
  }

  // Apply user display scale (> 1.0 = fewer pixels = bigger objects)
  const displayScale = useSettingsStore.getState().sessionDefaultsRdp.displayScale ?? 1.0;
  if (displayScale !== 1.0) {
    w = Math.round(w / displayScale);
    h = Math.round(h / displayScale);
  }

  // Ensure even dimensions, minimum 800x600
  w = Math.max(800, w - (w % 2));
  h = Math.max(600, h - (h % 2));

  // Compute scale factors
  let desktopScaleFactor = 100;
  let deviceScaleFactor = 100;
  if (enableHighDpi && dpr > 1) {
    desktopScaleFactor = Math.min(500, Math.max(100, Math.round(dpr * 100)));
    if (dpr <= 1.2) {
      deviceScaleFactor = 100;
    } else if (dpr <= 1.6) {
      deviceScaleFactor = 140;
    } else {
      deviceScaleFactor = 180;
    }
  }

  return { width: w, height: h, desktopScaleFactor, deviceScaleFactor, effectiveHighDpi: enableHighDpi };
}

interface EntryState {
  entries: EntryMeta[];
  folders: FolderData[];
  selectedEntryIds: Set<string>;
  /** Derived: returns the single ID when exactly 1 item selected, else null */
  selectedEntryId: string | null;

  // Actions
  loadAll: () => Promise<void>;
  createEntry: (params: {
    name: string;
    entry_type: EntryType;
    folder_id?: string | null;
    host?: string | null;
    port?: number | null;
    credential_id?: string | null;
    username?: string | null;
    password?: string | null;
    domain?: string | null;
    private_key?: string | null;
    icon?: string | null;
    color?: string | null;
    config?: Record<string, unknown>;
    tags?: string[];
    notes?: string | null;
    credential_type?: string | null;
    totp_secret?: string | null;
  }) => Promise<EntryMeta | null>;
  getEntry: (id: string) => Promise<EntryFull>;
  updateEntry: (id: string, updates: Partial<EntryMeta> & { password?: string | null; private_key?: string | null; totp_secret?: string | null }) => Promise<EntryMeta | null>;
  deleteEntry: (id: string) => Promise<void>;
  duplicateEntry: (id: string) => Promise<EntryMeta | null>;
  moveEntry: (id: string, folderId: string | null) => Promise<void>;
  resolveCredential: (id: string) => Promise<ResolvedCredential | null>;

  createFolder: (name: string, parentId?: string | null, icon?: string | null, color?: string | null) => Promise<FolderData | null>;
  updateFolder: (id: string, updates: { name?: string; parent_id?: string | null; sort_order?: number; icon?: string | null; color?: string | null }) => Promise<FolderData | null>;
  deleteFolder: (id: string) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;

  setSelectedEntry: (id: string | null) => void;
  toggleSelectedEntry: (id: string) => void;
  clearSelection: () => void;
  moveEntries: (ids: string[], folderId: string | null) => Promise<{ moved: number; failed: number }>;
  moveFolders: (ids: string[], parentId: string | null) => Promise<{ moved: number; failed: number }>;
  openEntry: (id: string) => Promise<void>;
  openEntryWithCredential: (id: string, credentialId: string) => Promise<void>;
  reconnectSession: (sessionId: string) => Promise<void>;
  reconnectRdpSession: (entryId: string) => Promise<void>;
}

// Tracks entries with an in-flight open to prevent duplicate sessions from double-clicks
const openingEntries = new Set<string>();

/** Derive selectedEntryId from a set: single item → its ID, otherwise null */
function deriveSingleId(ids: Set<string>): string | null {
  return ids.size === 1 ? ids.values().next().value! : null;
}

/**
 * Shared connection logic used by openEntry and openEntryWithCredential.
 * Handles adding sessions and invoking protocol-specific IPC for SSH/RDP/VNC/Web.
 */
async function connectEntry(
  entry: EntryMeta,
  cred: ResolvedCredential | null,
  sessionStore: ReturnType<typeof useSessionStore.getState>,
): Promise<void> {
  if (entry.entry_type === "document") {
    sessionStore.addSession({
      id: entry.id, type: "document", title: entry.name,
      status: "connected", entryId: entry.id,
    });
    return;
  }

  if (entry.entry_type === "command") {
    sessionStore.addSession({
      id: entry.id, type: "command", title: entry.name,
      status: "connecting", entryId: entry.id,
    });
    return;
  }

  if (entry.entry_type === "rdp") {
    sessionStore.addSession({
      id: entry.id, type: "rdp", title: entry.name,
      status: "connecting", entryId: entry.id,
    });

    const globalRdpDefaults = useSettingsStore.getState().sessionDefaultsRdp;
    const rdpCfg: RdpEntryConfig = resolveRdpConfig(entry.config as Partial<RdpEntryConfig>, globalRdpDefaults);
    const contentEl = document.querySelector('[data-content-area]');
    const { width: w, height: h, desktopScaleFactor, deviceScaleFactor, effectiveHighDpi } = computeRdpDimensions(rdpCfg, contentEl);

    invoke<{ sessionId: string; width: number; height: number; mode: string }>("rdp_connect", {
      sessionId: entry.id,
      host: entry.host,
      hostname: rdpCfg.hostname,
      port: entry.port ?? 3389,
      username: cred?.username ?? entry.username ?? "",
      password: cred?.password ?? "",
      domain: cred?.domain ?? entry.domain ?? undefined,
      width: w, height: h,
      enableNla: rdpCfg.enableNla,
      sharedFolders: rdpCfg.sharedFolders?.length ? rdpCfg.sharedFolders : undefined,
      colorDepth: rdpCfg.colorDepth,
      performanceMode: mapQualityToPerformanceMode(rdpCfg.quality),
      enableBitmapCache: true,
      enableServerPointer: true,
      frameRate: 30,
      desktopScaleFactor,
      deviceScaleFactor,
      enableClipboard: rdpCfg.clipboard,
    }).then((result) => {
      useSessionStore.getState().addSession({
        id: entry.id, type: "rdp", title: entry.name,
        status: "connected", entryId: entry.id,
        metadata: {
          rdpWidth: result.width, rdpHeight: result.height,
          rdpMode: result.mode, enableHighDpi: effectiveHighDpi,
          enableClipboard: rdpCfg.clipboard,
        },
      });
    }).catch((err) => {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Connection failed";
      useSessionStore.getState().updateSessionStatus(entry.id, "disconnected", msg);
    });
    return;
  }

  if (entry.entry_type === "vnc") {
    sessionStore.addSession({
      id: entry.id, type: "vnc", title: entry.name,
      status: "connecting", entryId: entry.id,
    });
    await invoke("vnc_connect", {
      sessionId: entry.id,
      host: entry.host,
      port: entry.port ?? 5900,
      password: cred?.password ?? "",
      username: cred?.username ?? undefined,
    });
    sessionStore.updateSessionStatus(entry.id, "connected");
    return;
  }

  if (entry.entry_type === "ssh") {
    sessionStore.addSession({
      id: entry.id, type: "ssh", title: entry.name,
      status: "connecting", entryId: entry.id,
    });
    const entryConfig = entry.config as Record<string, unknown> | undefined;
    const realSessionId = await invoke<string>("ssh_session_create", {
      host: entry.host,
      port: entry.port ?? 22,
      credentialId: entry.credential_id ?? null,
      username: cred?.username ?? null,
      password: cred?.password ?? null,
      privateKey: cred?.private_key ?? null,
      sshAuthMethod: (entryConfig?.ssh_auth_method as string) ?? null,
    });
    sessionStore.replaceSessionId(entry.id, realSessionId, { status: "connected" });
    return;
  }

  if (entry.entry_type === "web") {
    sessionStore.addSession({
      id: entry.id, type: "web", title: entry.name,
      status: "connecting", entryId: entry.id,
    });
    const url = entry.host || entry.name;
    const globalWebDefaults = useSettingsStore.getState().sessionDefaultsWeb;
    const resolvedWeb = resolveWebConfig(entry.config as Partial<WebEntryConfig>, globalWebDefaults);
    const realSessionId = await invoke<string>("web_session_create", {
      url,
      ignoreCertErrors: resolvedWeb.ignoreCertErrors,
      entryId: entry.id,
      engine: resolvedWeb.engine,
    });
    sessionStore.replaceSessionId(entry.id, realSessionId, { status: "connected" });
    return;
  }
}

export const useEntryStore = create<EntryState>((set, get) => ({
  entries: [],
  folders: [],
  selectedEntryIds: new Set<string>(),
  selectedEntryId: null,

  loadAll: async () => {
    // Guard: don't call IPC if the vault isn't unlocked
    if (!useVaultStore.getState().isUnlocked) {
      set({ entries: [], folders: [] });
      return;
    }
    try {
      const [entries, folders] = await Promise.all([
        invoke<EntryMeta[]>("entry_list"),
        invoke<FolderData[]>("folder_list"),
      ]);
      set({ entries, folders });
    } catch (err) {
      console.error("Failed to load entries/folders:", err);
    }
  },

  createEntry: async (params) => {
    try {
      // Tier enforcement: check entry limit for non-credential types
      const { authMode } = useAuthStore.getState();
      if (authMode !== 'local' && params.entry_type !== 'credential' && params.entry_type !== 'document') {
        if (!useTierStore.getState().canCreateEntry()) {
          toast.error("Entry limit reached — upgrade your plan to add more connections");
          return null;
        }
      }

      const entry = await invoke<EntryMeta>("entry_create", params);
      set((state) => ({ entries: [...state.entries, entry] }));
      if (params.entry_type === "credential") {
        useVaultStore.getState().loadCredentials();
      }
      return entry;
    } catch (err) {
      console.error("Failed to create entry:", err);
      return null;
    }
  },

  duplicateEntry: async (id) => {
    try {
      const entry = get().entries.find((e) => e.id === id);
      if (!entry) return null;

      const { authMode } = useAuthStore.getState();
      if (authMode !== 'local' && entry.entry_type !== 'credential' && entry.entry_type !== 'document') {
        if (!useTierStore.getState().canCreateEntry()) {
          toast.error("Entry limit reached — upgrade your plan to add more connections");
          return null;
        }
      }

      const newEntry = await invoke<EntryMeta>("entry_duplicate", { id });
      set((state) => ({ entries: [...state.entries, newEntry] }));
      if (newEntry.entry_type === "credential") {
        useVaultStore.getState().loadCredentials();
      }
      return newEntry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('TIER_LIMIT_REACHED')) {
        toast.error("Entry limit reached — upgrade your plan to add more connections");
      } else {
        console.error("Failed to duplicate entry:", err);
        toast.error("Failed to duplicate entry");
      }
      return null;
    }
  },

  getEntry: async (id) => {
    return await invoke<EntryFull>("entry_get_full", { id });
  },

  updateEntry: async (id, updates) => {
    try {
      const entry = await invoke<EntryMeta>("entry_update", { id, ...updates });
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? entry : e)),
      }));
      if (entry.entry_type === "credential") {
        useVaultStore.getState().loadCredentials();
      }
      return entry;
    } catch (err) {
      console.error("Failed to update entry:", err);
      return null;
    }
  },

  deleteEntry: async (id) => {
    try {
      await invoke("entry_delete", { id });
      set((state) => {
        const nextIds = new Set(state.selectedEntryIds);
        nextIds.delete(id);
        return {
          entries: state.entries.filter((e) => e.id !== id),
          selectedEntryIds: nextIds,
          selectedEntryId: deriveSingleId(nextIds),
        };
      });
      useVaultStore.getState().loadCredentials();
    } catch (err) {
      console.error("Failed to delete entry:", err);
    }
  },

  moveEntry: async (id, folderId) => {
    try {
      const entry = await invoke<EntryMeta>("entry_move", { id, folder_id: folderId });
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? entry : e)),
      }));
    } catch (err) {
      console.error("Failed to move entry:", err);
    }
  },

  resolveCredential: async (id) => {
    try {
      return await invoke<ResolvedCredential | null>("entry_resolve_credential", { id });
    } catch (err) {
      console.error("Failed to resolve credential:", err);
      return null;
    }
  },

  createFolder: async (name, parentId, icon, color) => {
    try {
      const folder = await invoke<FolderData>("folder_create", { name, parent_id: parentId ?? null, icon: icon ?? null, color: color ?? null });
      set((state) => ({ folders: [...state.folders, folder] }));
      return folder;
    } catch (err) {
      console.error("Failed to create folder:", err);
      return null;
    }
  },

  updateFolder: async (id, updates) => {
    try {
      const folder = await invoke<FolderData>("folder_update", { id, ...updates });
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? folder : f)),
      }));
      return folder;
    } catch (err) {
      console.error("Failed to update folder:", err);
      return null;
    }
  },

  deleteFolder: async (id) => {
    try {
      await invoke("folder_delete", { id });
      set((state) => {
        // Collect all descendant folder IDs recursively
        const descendantFolderIds = new Set<string>();
        const collectDescendants = (parentId: string) => {
          descendantFolderIds.add(parentId);
          for (const f of state.folders) {
            if (f.parent_id === parentId && !descendantFolderIds.has(f.id)) {
              collectDescendants(f.id);
            }
          }
        };
        collectDescendants(id);

        const nextIds = new Set(state.selectedEntryIds);
        for (const fid of descendantFolderIds) nextIds.delete(fid);
        // Also deselect entries that were in deleted folders
        for (const entry of state.entries) {
          if (entry.folder_id && descendantFolderIds.has(entry.folder_id)) {
            nextIds.delete(entry.id);
          }
        }

        return {
          folders: state.folders.filter((f) => !descendantFolderIds.has(f.id)),
          entries: state.entries.filter((e) => !e.folder_id || !descendantFolderIds.has(e.folder_id)),
          selectedEntryIds: nextIds,
          selectedEntryId: deriveSingleId(nextIds),
        };
      });
    } catch (err) {
      console.error("Failed to delete folder:", err);
    }
  },

  moveFolder: async (id, parentId) => {
    try {
      const folder = await invoke<FolderData>("folder_move", { id, parent_id: parentId });
      set((state) => ({
        folders: state.folders.map((f) => (f.id === id ? folder : f)),
      }));
    } catch (err) {
      console.error("Failed to move folder:", err);
    }
  },

  setSelectedEntry: (id) => {
    const nextIds = id ? new Set([id]) : new Set<string>();
    set({ selectedEntryIds: nextIds, selectedEntryId: id });
  },

  toggleSelectedEntry: (id) => {
    set((state) => {
      const nextIds = new Set(state.selectedEntryIds);
      if (nextIds.has(id)) {
        nextIds.delete(id);
      } else {
        nextIds.add(id);
      }
      return { selectedEntryIds: nextIds, selectedEntryId: deriveSingleId(nextIds) };
    });
  },

  clearSelection: () => {
    set({ selectedEntryIds: new Set<string>(), selectedEntryId: null });
  },

  moveEntries: async (ids, folderId) => {
    let moved = 0, failed = 0;
    for (const id of ids) {
      try {
        const entry = await invoke<EntryMeta>("entry_move", { id, folder_id: folderId });
        set((state) => ({
          entries: state.entries.map((e) => (e.id === id ? entry : e)),
        }));
        moved++;
      } catch {
        failed++;
      }
    }
    return { moved, failed };
  },

  moveFolders: async (ids, parentId) => {
    let moved = 0, failed = 0;
    for (const id of ids) {
      try {
        const folder = await invoke<FolderData>("folder_move", { id, parent_id: parentId });
        set((state) => ({
          folders: state.folders.map((f) => (f.id === id ? folder : f)),
        }));
        moved++;
      } catch {
        failed++;
      }
    }
    return { moved, failed };
  },

  openEntry: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry || entry.entry_type === "credential") return;

    // Tier enforcement: prevent opening locked entries
    if (useTierStore.getState().isEntryLocked(id)) {
      toast.error("This entry is locked — upgrade your plan to access it");
      return;
    }

    // Prevent duplicate sessions from rapid double-clicks
    if (openingEntries.has(id)) return;
    openingEntries.add(id);

    // Collapse sidebar immediately for instant feedback
    const { isExpanded, collapse: collapseSidebar } = useSidebarStore.getState();
    if (isExpanded) {
      collapseSidebar();
    }

    const sessionStore = useSessionStore.getState();

    try {
      const cred = await get().resolveCredential(id);
      await connectEntry(entry, cred, sessionStore);
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Connection failed";
      sessionStore.updateSessionStatus(entry.id, "disconnected", msg);
      console.error("Failed to open entry:", err);
    } finally {
      openingEntries.delete(id);
    }
  },

  openEntryWithCredential: async (id, credentialId) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry || entry.entry_type === "credential") return;

    if (useTierStore.getState().isEntryLocked(id)) {
      toast.error("This entry is locked — upgrade your plan to access it");
      return;
    }

    if (openingEntries.has(id)) return;
    openingEntries.add(id);

    const { isExpanded: isExpanded2, collapse: collapseSidebar2 } = useSidebarStore.getState();
    if (isExpanded2) {
      collapseSidebar2();
    }

    const sessionStore = useSessionStore.getState();

    try {
      const credDto = await useVaultStore.getState().getCredential(credentialId);
      const cred: ResolvedCredential = {
        source: 'explicit',
        source_entry_id: credentialId,
        source_folder_id: null,
        username: credDto.username,
        password: credDto.password,
        domain: credDto.domain,
        private_key: credDto.private_key,
      };
      await connectEntry(entry, cred, sessionStore);
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Connection failed";
      sessionStore.updateSessionStatus(entry.id, "disconnected", msg);
      console.error("Failed to open entry with credential:", err);
    } finally {
      openingEntries.delete(id);
    }
  },

  reconnectSession: async (sessionId) => {
    const sessionStore = useSessionStore.getState();
    const session = sessionStore.sessions.find((s) => s.id === sessionId);
    if (!session?.entryId) return;
    if (session.metadata?.reconnecting) return; // guard against double-click

    const entryId = session.entryId;
    const sessionType = session.type;

    // 1. Mark as reconnecting immediately (tab stays, shows spinner)
    sessionStore.updateSessionStatus(sessionId, "connecting");
    sessionStore.updateSessionMetadata(sessionId, { reconnecting: true });

    // 2. Disconnect backend WITHOUT removing session from store
    try {
      switch (sessionType) {
        case "rdp": await invoke("rdp_disconnect", { sessionId }); break;
        case "vnc": await invoke("vnc_disconnect", { sessionId }); break;
        case "ssh": case "local_shell":
          await invoke("terminal_close", { sessionId });
          disposeTerminalEntry(sessionId);
          break;
        case "web": await invoke("web_session_close", { sessionId }); break;
        case "command": await invoke("command_cancel", { sessionId }).catch(() => {}); break;
      }
    } catch { /* may already be disconnected */ }

    // 3. Wait for RDP server to release session slot
    if (sessionType === "rdp") {
      await new Promise((r) => setTimeout(r, 3000));
    }

    // 4. For SSH/web sessions, the session ID differs from the entry ID
    //    (connectEntry creates with entry.id then replaces via replaceSessionId).
    //    Reset the ID back to entry.id so connectEntry's addSession deduplicates
    //    in-place and replaceSessionId updates the same slot.
    let trackingId = sessionId;
    if (sessionId !== entryId) {
      sessionStore.replaceSessionId(sessionId, entryId, { status: "connecting" });
      trackingId = entryId;
    }

    // 5. Bail if session was closed by user during the wait
    if (!useSessionStore.getState().sessions.find((s) => s.id === trackingId)) return;

    // 6. Reconnect via openEntry (addSession deduplicates by ID, so session updates in-place)
    try {
      await get().openEntry(entryId);
    } catch (err) {
      const msg = typeof err === "string" ? err : err instanceof Error ? err.message : "Reconnection failed";
      useSessionStore.getState().updateSessionStatus(trackingId, "disconnected", msg);
    } finally {
      // Clear reconnecting flag — find by entryId since ID may have changed again
      const current = useSessionStore.getState().sessions.find((s) => s.entryId === entryId);
      if (current) {
        useSessionStore.getState().updateSessionMetadata(current.id, { reconnecting: false });
      }
    }
  },

  reconnectRdpSession: async (entryId) => {
    const session = useSessionStore.getState().sessions.find(
      (s) => s.entryId === entryId && s.type === "rdp"
    );
    if (session) await get().reconnectSession(session.id);
  },
}));
