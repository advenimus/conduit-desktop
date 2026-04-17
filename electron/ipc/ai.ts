/**
 * AI IPC handlers for the Electron main process.
 *
 * Registers handlers for tier capabilities, MCP binary path lookup, and
 * persistent chat history (engine conversations). The built-in AI agent
 * has been removed — all chat now flows through external CLI engines
 * (Claude Code, Codex) via electron/ipc/engine.ts.
 */

import { ipcMain, app } from 'electron';
import path from 'node:path';
import type { AppState } from '../services/state.js';
import { readSettings, writeSettings } from './settings.js';

export function registerAiHandlers(state: AppState): void {
  ipcMain.handle('ai_get_mcp_path', async () => {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp', 'dist', 'index.js');
    }
    return path.resolve(app.getAppPath(), 'mcp', 'dist', 'index.js');
  });

  // ── Tier-aware handlers ──────────────────────────────────────────────────

  /** Returns the user's AI feature flags for frontend gating. */
  ipcMain.handle('ai_get_tier_capabilities', async () => {
    const authState = state.authService.getAuthState();
    let profile = authState.profile;

    // If authenticated but profile hasn't loaded yet (race condition on startup),
    // fetch it directly before computing capabilities.
    if (!profile && authState.user) {
      try {
        profile = await state.authService.getUserProfile();
      } catch { /* fall through to defaults */ }
    }

    if (!profile) {
      return {
        cli_agents_enabled: false,
        mcp_enabled: false,
        mcp_daily_quota: 50,
        chat_cloud_sync_enabled: false,
        tier_name: 'free',
        tier_display_name: 'Free',
        is_team_member: false,
      };
    }

    const features = profile.tier?.features as Record<string, unknown> ?? {};

    const capabilities = {
      cli_agents_enabled: !!features.cli_agents_enabled,
      mcp_enabled: !!features.mcp_enabled,
      mcp_daily_quota: typeof features.mcp_daily_quota === 'number' ? features.mcp_daily_quota : 50,
      chat_cloud_sync_enabled: !!features.chat_cloud_sync_enabled,
      tier_name: profile.tier?.name ?? 'free',
      tier_display_name: profile.tier?.display_name ?? 'Free',
      is_team_member: profile.is_team_member,
    };

    // Cache tier capabilities for offline/degraded mode
    try {
      const settings = readSettings();
      settings.cached_tier_capabilities = capabilities;
      settings.cached_tier_timestamp = new Date().toISOString();
      settings.cached_user_email = authState.user?.email;
      writeSettings(settings);
    } catch (err) {
      console.warn('[ai:ipc] Failed to cache tier capabilities:', err);
    }

    return capabilities;
  });

  /** Returns cached tier capabilities from settings (for offline mode). */
  ipcMain.handle('ai_get_cached_tier_capabilities', async () => {
    try {
      const settings = readSettings();
      if (!settings.cached_tier_capabilities || !settings.cached_tier_timestamp) return null;
      const age = Date.now() - new Date(settings.cached_tier_timestamp).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (age > sevenDays) return null;
      return settings.cached_tier_capabilities;
    } catch {
      return null;
    }
  });

  // ── Persistent chat history handlers ────────────────────────────────────
  // These serve engine conversations (Claude Code, Codex) stored in ChatStore.

  /** Delete an engine conversation and its linked engine session. */
  ipcMain.handle('ai_delete_conversation', async (_e, args) => {
    const { conversationId } = args as { conversationId: string };
    if (!state.chatStore.isUnlocked()) {
      throw new Error('Chat store is locked');
    }
    const conv = state.chatStore.getConversation(conversationId);
    if (!conv) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    if (conv.engineSessionId) {
      try {
        const engineType = (conv.provider === 'codex' ? 'codex' : 'claude-code') as import('../services/ai/engines/engine.js').EngineType;
        await state.engineManager.destroySession(engineType, conv.engineSessionId);
      } catch (err) {
        console.warn('[ai:ipc] Failed to destroy engine session:', err);
      }
      try {
        state.chatStore.deleteEngineSession(conv.engineSessionId);
      } catch (err) {
        console.warn('[ai:ipc] Failed to delete engine session from store:', err);
      }
    }
    state.chatStore.deleteConversation(conversationId);
  });

  /** List persisted conversations with optional search. */
  ipcMain.handle('chat_list_conversations', async (_e, args) => {
    const { limit, offset, search } = (args ?? {}) as {
      limit?: number;
      offset?: number;
      search?: string;
    };
    if (!state.chatStore.isUnlocked()) return [];
    const all = state.chatStore.listConversations({ limit, offset, search });
    // Filter out legacy built-in conversations (provider 'anthropic' / 'openai')
    // that were created by the removed built-in agent. Only engine (Claude Code /
    // Codex) conversations are surfaced now.
    return all.filter((c) => c.provider === 'claude-code' || c.provider === 'codex');
  });

  /** Get messages for a specific conversation. */
  ipcMain.handle('chat_get_messages', async (_e, args) => {
    const { conversationId } = args as { conversationId: string };
    if (!state.chatStore.isUnlocked()) return [];
    try {
      return state.chatStore.getMessages(conversationId);
    } catch (err) {
      console.warn(`[ai:ipc] Failed to decrypt messages for ${conversationId}:`, err);
      return [];
    }
  });

  /** Update a conversation's title or pinned status. */
  ipcMain.handle('chat_update_conversation', async (_e, args) => {
    const { conversationId, title, isPinned } = args as {
      conversationId: string;
      title?: string;
      isPinned?: boolean;
    };
    if (!state.chatStore.isUnlocked()) throw new Error('Chat store is locked');
    state.chatStore.updateConversation(conversationId, { title, isPinned });
  });

  /** Clear all chat history. */
  ipcMain.handle('chat_clear_all', async () => {
    if (!state.chatStore.isUnlocked()) throw new Error('Chat store is locked');
    state.chatStore.clearAll();
  });

  /** Get conversation count. */
  ipcMain.handle('chat_get_conversation_count', async () => {
    if (!state.chatStore.isUnlocked()) return 0;
    return state.chatStore.countConversations();
  });
}
