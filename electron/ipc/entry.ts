/**
 * IPC handlers for unified entry CRUD.
 * Replaces the old connection.ts handlers.
 */

import { ipcMain, shell, app } from 'electron';
import { AppState, Session } from '../services/state.js';
import { logAudit } from '../services/audit.js';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

export function registerEntryHandlers(): void {
  const state = AppState.getInstance();

  // ── entry_list ──────────────────────────────────────────────────
  ipcMain.handle('entry_list', async () => {
    const vault = state.getActiveVault();
    if (!vault.isUnlocked()) return [];
    return vault.listEntries();
  });

  // ── entry_get (metadata only) ─────────────────────────────────
  ipcMain.handle('entry_get', async (_e, args: { id: string }) => {
    return state.getActiveVault().getEntryMeta(args.id);
  });

  // ── entry_get_full (with decrypted secrets) ───────────────────
  ipcMain.handle('entry_get_full', async (_e, args: { id: string }) => {
    return state.getActiveVault().getEntry(args.id);
  });

  // ── entry_create ──────────────────────────────────────────────
  ipcMain.handle('entry_create', async (_e, args: {
    name: string;
    entry_type: string;
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
  }) => {
    // Tier enforcement (defense-in-depth) — skip for team vaults
    const isTeamVault = state.teamVaultManager.getActiveVaultId() !== null;
    if (!isTeamVault && args.entry_type !== 'credential' && args.entry_type !== 'document') {
      const authState = state.authService?.getAuthState();
      if (authState && authState.authMode !== 'local' && authState.profile) {
        const maxConn = typeof authState.profile.tier?.features?.max_connections === 'number'
          ? authState.profile.tier.features.max_connections as number
          : 0;
        if (maxConn !== -1) {
          const entries = state.getActiveVault().listEntries();
          const connectionCount = entries.filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document').length;
          if (connectionCount >= maxConn) {
            throw new Error('TIER_LIMIT_REACHED');
          }
        }
      }
    }

    const entry = state.getActiveVault().createEntry({
      name: args.name,
      entry_type: args.entry_type as 'ssh' | 'rdp' | 'vnc' | 'web' | 'credential' | 'command',
      folder_id: args.folder_id,
      host: args.host,
      port: args.port,
      credential_id: args.credential_id,
      username: args.username,
      password: args.password,
      domain: args.domain,
      private_key: args.private_key,
      icon: args.icon,
      color: args.color,
      config: args.config,
      tags: args.tags,
      notes: args.notes,
      credential_type: args.credential_type,
      totp_secret: args.totp_secret,
    });

    logAudit(state, {
      action: 'entry_create', targetType: 'entry',
      targetId: entry.id, targetName: entry.name,
      details: { entry_type: args.entry_type, folder_id: args.folder_id ?? null },
    });

    return entry;
  });

  // ── entry_duplicate ────────────────────────────────────────────
  ipcMain.handle('entry_duplicate', async (_e, args: { id: string }) => {
    const vault = state.getActiveVault();
    const original = vault.getEntryMeta(args.id);

    // Tier enforcement (defense-in-depth) — skip for team vaults, credentials, documents
    const isTeamVault = state.teamVaultManager.getActiveVaultId() !== null;
    if (!isTeamVault && original.entry_type !== 'credential' && original.entry_type !== 'document') {
      const authState = state.authService?.getAuthState();
      if (authState && authState.authMode !== 'local' && authState.profile) {
        const maxConn = typeof authState.profile.tier?.features?.max_connections === 'number'
          ? authState.profile.tier.features.max_connections as number
          : 0;
        if (maxConn !== -1) {
          const entries = vault.listEntries();
          const connectionCount = entries.filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document').length;
          if (connectionCount >= maxConn) {
            throw new Error('TIER_LIMIT_REACHED');
          }
        }
      }
    }

    const entry = vault.duplicateEntry(args.id);

    logAudit(state, {
      action: 'entry_duplicate', targetType: 'entry',
      targetId: entry.id, targetName: entry.name,
      details: { source_entry_id: args.id, entry_type: entry.entry_type },
    });

    return entry;
  });

  // ── entry_update ──────────────────────────────────────────────
  ipcMain.handle('entry_update', async (_e, args: {
    id: string;
    name?: string;
    entry_type?: string;
    folder_id?: string | null;
    sort_order?: number;
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
    is_favorite?: boolean;
    notes?: string | null;
    credential_type?: string | null;
    totp_secret?: string | null;
  }) => {
    const { id, ...input } = args;

    let previousName: string | undefined;
    try { previousName = state.getActiveVault().getEntryMeta(id)?.name; } catch {}

    // Record password history if password or username is changing
    let passwordChanging = false;
    let usernameChanging = false;
    try {
      const existing = state.getActiveVault().getEntry(id);
      passwordChanging = input.password !== undefined && input.password !== existing.password;
      usernameChanging = input.username !== undefined && input.username !== existing.username;
      if (passwordChanging || usernameChanging) {
        const authState = state.authService?.getAuthState();
        const changedBy = authState?.user?.email ?? null;
        state.getActiveVault().recordPasswordHistory(id, existing.username, existing.password, changedBy);
      }
    } catch {}

    const result = state.getActiveVault().updateEntry(id, input as Parameters<ReturnType<typeof state.getActiveVault>['updateEntry']>[1]);

    if (passwordChanging || usernameChanging) {
      logAudit(state, {
        action: 'password_changed',
        targetType: 'entry',
        targetId: id,
        targetName: result.name,
        details: {
          fields_changed: [
            ...(passwordChanging ? ['password'] : []),
            ...(usernameChanging ? ['username'] : []),
          ],
        },
      });
    }

    const changedFields = Object.keys(input);
    logAudit(state, {
      action: 'entry_update', targetType: 'entry',
      targetId: id, targetName: result.name,
      details: {
        changed_fields: changedFields,
        ...(previousName && previousName !== result.name ? { previous_name: previousName } : {}),
      },
    });

    return result;
  });

  // ── entry_delete ──────────────────────────────────────────────
  ipcMain.handle('entry_delete', async (_e, args: { id: string }) => {
    let entryName: string | undefined;
    let entryType: string | undefined;
    try {
      const m = state.getActiveVault().getEntryMeta(args.id);
      entryName = m?.name;
      entryType = m?.entry_type;
    } catch {}

    state.getActiveVault().deleteEntry(args.id);

    logAudit(state, {
      action: 'entry_delete', targetType: 'entry',
      targetId: args.id, targetName: entryName,
      details: { entry_type: entryType },
    });
  });

  // ── entry_move ────────────────────────────────────────────────
  ipcMain.handle('entry_move', async (_e, args: { id: string; folder_id: string | null }) => {
    let meta: { name?: string; folder_id?: string | null } = {};
    try {
      const m = state.getActiveVault().getEntryMeta(args.id);
      if (m) meta = { name: m.name, folder_id: m.folder_id };
    } catch {}

    const result = state.getActiveVault().moveEntry(args.id, args.folder_id);

    logAudit(state, {
      action: 'entry_update', targetType: 'entry',
      targetId: args.id, targetName: meta.name,
      details: {
        changed_fields: ['folder_id'],
        previous_folder_id: meta.folder_id ?? null,
        new_folder_id: args.folder_id,
      },
    });

    return result;
  });

  // ── entry_resolve_credential ──────────────────────────────────
  ipcMain.handle('entry_resolve_credential', async (_e, args: { id: string }) => {
    return state.getActiveVault().resolveCredential(args.id);
  });

  // ── entry_connect (open a session for an entry) ───────────────
  ipcMain.handle('entry_connect', async (_e, args: { id: string }) => {
    const entry = state.getActiveVault().getEntryMeta(args.id);
    if (!entry) {
      throw new Error(`Entry not found: ${args.id}`);
    }

    const session: Session = {
      id: uuidv4(),
      connection_id: args.id,
      type: entry.entry_type,
      title: entry.name,
      is_connected: true,
    };

    state.sessions.set(session.id, session);
    return session;
  });

  // ── Keep old connection_list for backward compat (MCP) ────────
  ipcMain.handle('connection_list', async () => {
    const vault = state.getActiveVault();
    if (!vault.isUnlocked()) return [];
    const entries = vault.listEntries();
    return entries
      .filter((e) => e.entry_type !== 'credential')
      .map((e) => ({
        id: e.id,
        name: e.name,
        connection_type: e.entry_type,
        host: e.host,
        port: e.port,
        credential_id: e.credential_id,
        folder_id: e.folder_id,
      }));
  });

  // ── Keep old connection_create for backward compat ─────────────
  ipcMain.handle('connection_create', async (_e, args: {
    name: string;
    connection_type: string;
    host?: string | null;
    port?: number | null;
    credential_id?: string | null;
    folder_id?: string | null;
  }) => {
    // Tier enforcement (defense-in-depth) — skip for team vaults
    const isTeamVaultLegacy = state.teamVaultManager.getActiveVaultId() !== null;
    if (!isTeamVaultLegacy) {
      const authState = state.authService?.getAuthState();
      if (authState && authState.authMode !== 'local' && authState.profile) {
        const maxConn = typeof authState.profile.tier?.features?.max_connections === 'number'
          ? authState.profile.tier.features.max_connections as number
          : -1; // fail-open: if feature not defined, no limit
        if (maxConn !== -1) {
          const entries = state.getActiveVault().listEntries();
          const connectionCount = entries.filter((e) => e.entry_type !== 'credential' && e.entry_type !== 'document').length;
          if (connectionCount >= maxConn) {
            throw new Error('TIER_LIMIT_REACHED');
          }
        }
      }
    }

    const entry = state.getActiveVault().createEntry({
      name: args.name,
      entry_type: args.connection_type as 'ssh' | 'rdp' | 'vnc' | 'web',
      host: args.host,
      port: args.port,
      credential_id: args.credential_id,
      folder_id: args.folder_id,
    });

    logAudit(state, {
      action: 'entry_create', targetType: 'entry',
      targetId: entry.id, targetName: entry.name,
      details: { entry_type: args.connection_type, folder_id: args.folder_id ?? null },
    });

    // Fire anonymous analytics — connection type only, no PII
    import('../services/analytics.js').then(({ track }) => {
      track('connection.created', { connection_type: args.connection_type });
    }).catch(() => {});

    return {
      id: entry.id,
      name: entry.name,
      connection_type: entry.entry_type,
      host: entry.host,
      port: entry.port,
      credential_id: entry.credential_id,
      folder_id: entry.folder_id,
    };
  });

  // ── Keep old connection_delete for backward compat ─────────────
  ipcMain.handle('connection_delete', async (_e, args: { id: string }) => {
    let entryName: string | undefined;
    let entryType: string | undefined;
    try {
      const m = state.getActiveVault().getEntryMeta(args.id);
      entryName = m?.name;
      entryType = m?.entry_type;
    } catch {}

    state.getActiveVault().deleteEntry(args.id);

    logAudit(state, {
      action: 'entry_delete', targetType: 'entry',
      targetId: args.id, targetName: entryName,
      details: { entry_type: entryType },
    });
  });

  // ── connection_connect (legacy) ───────────────────────────────
  ipcMain.handle('connection_connect', async (_e, args: { id: string }) => {
    const entry = state.getActiveVault().getEntryMeta(args.id);

    const session: Session = {
      id: uuidv4(),
      connection_id: args.id,
      type: entry.entry_type,
      title: entry.name,
      is_connected: true,
    };

    state.sessions.set(session.id, session);
    return session;
  });

  // ── connection_disconnect (legacy) ────────────────────────────
  ipcMain.handle('connection_disconnect', async (_e, args: { session_id: string }) => {
    state.sessions.delete(args.session_id);
  });

  // ── entry_open_external ─────────────────────────────────────
  ipcMain.handle('entry_open_external', async (_e, args: { id: string }) => {
    const entry = state.getActiveVault().getEntryMeta(args.id);
    if (!entry) throw new Error(`Entry not found: ${args.id}`);

    const host = entry.host ?? 'localhost';
    const port = entry.port;

    switch (entry.entry_type) {
      case 'web': {
        let url = host;
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        console.log(`[entry] open_external: type=web url=${url} entry=${entry.id.slice(0, 8)}`);
        await shell.openExternal(url);
        break;
      }
      case 'ssh': {
        const user = entry.username ?? '';
        const sshUrl = user
          ? `ssh://${user}@${host}${port && port !== 22 ? `:${port}` : ''}`
          : `ssh://${host}${port && port !== 22 ? `:${port}` : ''}`;
        console.log(`[entry] open_external: type=ssh url=${sshUrl} entry=${entry.id.slice(0, 8)}`);
        await shell.openExternal(sshUrl);
        break;
      }
      case 'vnc': {
        const vncUrl = `vnc://${host}${port && port !== 5900 ? `:${port}` : ''}`;
        console.log(`[entry] open_external: type=vnc url=${vncUrl} entry=${entry.id.slice(0, 8)}`);
        await shell.openExternal(vncUrl);
        break;
      }
      case 'rdp': {
        const rdpPort = port ?? 3389;
        const config = (entry.config ?? {}) as Record<string, unknown>;
        const lines = [
          `full address:s:${host}:${rdpPort}`,
          'prompt for credentials:i:1',
          'screen mode id:i:1',
        ];
        if (config.colorDepth) lines.push(`session bpp:i:${config.colorDepth}`);
        if (config.sound) {
          const soundMap: Record<string, number> = { local: 0, remote: 1, none: 2 };
          lines.push(`audiomode:i:${soundMap[config.sound as string] ?? 0}`);
        }
        if (typeof config.clipboard === 'boolean') {
          lines.push(`redirectclipboard:i:${config.clipboard ? 1 : 0}`);
        }

        const tmpDir = app.getPath('temp');
        const rdpFile = path.join(tmpDir, `conduit-${entry.id.slice(0, 8)}.rdp`);
        fs.writeFileSync(rdpFile, lines.join('\r\n') + '\r\n', 'utf-8');
        console.log(`[entry] open_external: type=rdp file=${rdpFile} entry=${entry.id.slice(0, 8)}`);
        const errMsg = await shell.openPath(rdpFile);
        if (errMsg) throw new Error(`Failed to open RDP file: ${errMsg}`);
        break;
      }
      default:
        throw new Error(`Cannot open externally: unsupported entry type "${entry.entry_type}"`);
    }

    logAudit(state, {
      action: 'entry_open_external', targetType: 'entry',
      targetId: entry.id, targetName: entry.name,
      details: { entry_type: entry.entry_type },
    });
  });
}
