import { create } from "zustand";
import { invoke } from "../lib/electron";

export type ConnectionType = "ssh" | "rdp" | "vnc" | "web" | "local_shell";

export interface SavedConnection {
  id: string;
  name: string;
  type: ConnectionType;
  host?: string;
  port?: number;
  credentialId?: string;
  folderId?: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId?: string;
}

interface ConnectionState {
  connections: SavedConnection[];
  folders: Folder[];

  // Actions
  loadConnections: () => Promise<void>;
  addConnection: (params: {
    name: string;
    type: ConnectionType;
    host?: string;
    port?: number;
    credentialId?: string;
    folderId?: string;
  }) => Promise<SavedConnection | null>;
  removeConnection: (id: string) => Promise<void>;
  updateConnection: (id: string, updates: Partial<SavedConnection>) => void;
  moveConnection: (connectionId: string, targetFolderId: string) => void;

  addFolder: (folder: Folder) => void;
  removeFolder: (id: string) => void;
  renameFolder: (id: string, name: string) => void;
  moveFolder: (folderId: string, targetFolderId: string) => void;

  openConnection: (id: string) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  folders: [],

  loadConnections: async () => {
    try {
      const result = await invoke<Array<{
        id: string;
        name: string;
        connection_type: string;
        host: string | null;
        port: number | null;
        credential_id: string | null;
        folder_id: string | null;
      }>>("connection_list");

      const connections: SavedConnection[] = result.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.connection_type as ConnectionType,
        host: c.host ?? undefined,
        port: c.port ?? undefined,
        credentialId: c.credential_id ?? undefined,
        folderId: c.folder_id ?? undefined,
      }));

      set({ connections });
    } catch (err) {
      console.error("Failed to load connections:", err);
    }
  },

  addConnection: async (params) => {
    try {
      const result = await invoke<{
        id: string;
        name: string;
        connection_type: string;
        host: string | null;
        port: number | null;
        credential_id: string | null;
        folder_id: string | null;
      }>("connection_create", {
        name: params.name,
        connection_type: params.type,
        host: params.host ?? null,
        port: params.port ?? null,
        credential_id: params.credentialId ?? null,
        folder_id: params.folderId ?? null,
      });

      const saved: SavedConnection = {
        id: result.id,
        name: result.name,
        type: result.connection_type as ConnectionType,
        host: result.host ?? undefined,
        port: result.port ?? undefined,
        credentialId: result.credential_id ?? undefined,
        folderId: result.folder_id ?? undefined,
      };

      set((state) => ({
        connections: [...state.connections, saved],
      }));

      return saved;
    } catch (err) {
      console.error("Failed to save connection:", err);
      return null;
    }
  },

  removeConnection: async (id) => {
    try {
      await invoke("connection_delete", { id });
    } catch (err) {
      console.error("Failed to delete connection:", err);
    }
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    }));
  },

  updateConnection: (id, updates) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, ...updates } : c
      ),
    })),

  moveConnection: (connectionId, targetFolderId) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === connectionId ? { ...c, folderId: targetFolderId } : c
      ),
    })),

  addFolder: (folder) =>
    set((state) => ({
      folders: [...state.folders, folder],
    })),

  removeFolder: (id) =>
    set((state) => ({
      folders: state.folders.filter((f) => f.id !== id),
      // Move connections out of deleted folder
      connections: state.connections.map((c) =>
        c.folderId === id ? { ...c, folderId: undefined } : c
      ),
    })),

  renameFolder: (id, name) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === id ? { ...f, name } : f
      ),
    })),

  moveFolder: (folderId, targetFolderId) =>
    set((state) => ({
      folders: state.folders.map((f) =>
        f.id === folderId ? { ...f, parentId: targetFolderId } : f
      ),
    })),

  openConnection: async (id) => {
    const conn = get().connections.find((c) => c.id === id);
    if (!conn) return;

    try {
      await invoke("connection_connect", { id: conn.id });
    } catch (err) {
      console.error("Failed to open connection:", err);
    }
  },
}));
