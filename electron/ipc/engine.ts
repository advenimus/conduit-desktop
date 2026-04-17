/**
 * Engine IPC handlers — expose the unified engine abstraction to the renderer.
 *
 * These handlers run alongside the existing ai_* handlers.  The built-in
 * engine continues to use the old ai_* IPC path; these handlers are for
 * the SDK engines (Claude Code, Codex).
 */

import { ipcMain, app, BrowserWindow } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import type { AppState } from '../services/state.js';
import type { EngineType, ChatEngineEvent, EngineModelInfo, MessageBlock } from '../services/ai/engines/engine.js';
import { readSettings, writeSettings } from './settings.js';
import { getSocketPath } from '../ipc-server/server.js';
import { getDataDir } from '../services/env-config.js';

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

/** Active abort controllers for engine turns, keyed by sessionId. */
const activeAbortControllers = new Map<string, AbortController>();

// ── Persistence helpers ──────────────────────────────────────────────────────

/**
 * Get or create a conversations row linked to an engine session.
 * Returns the conversation ID.
 */
function getOrCreateEngineConversation(
  state: AppState,
  sessionId: string,
  engineType: string,
  model?: string,
): string | null {
  try {
    if (!state.chatStore.isUnlocked()) return null;

    // Check for existing conversation linked to this session
    const existing = state.chatStore.findConversationByEngineSession(sessionId);
    if (existing) return existing.id;

    // Create a new conversation
    const convId = uuidv4();
    state.chatStore.createEngineConversation({
      id: convId,
      provider: engineType,
      model: model ?? 'default',
      engineSessionId: sessionId,
    });
    return convId;
  } catch (err) {
    console.warn('[engine:ipc] Failed to get/create engine conversation:', err);
    return null;
  }
}

function persistEngineUserMessage(
  state: AppState,
  convId: string,
  message: string,
): void {
  try {
    if (!state.chatStore.isUnlocked()) return;
    state.chatStore.addEngineMessage(convId, {
      id: uuidv4(),
      role: 'user',
      blocks: [{ type: 'text', content: message }],
    });
  } catch (err) {
    console.warn('[engine:ipc] Failed to persist user message:', err);
  }
}

function persistEngineAssistantMessage(
  state: AppState,
  convId: string,
  blocks: MessageBlock[],
): void {
  try {
    if (!state.chatStore.isUnlocked()) return;
    state.chatStore.addEngineMessage(convId, {
      id: uuidv4(),
      role: 'assistant',
      blocks,
    });

    // Trigger cloud sync
    if (state.chatCloudSync) {
      state.chatCloudSync.notifyMutation(convId);
    }
  } catch (err) {
    console.warn('[engine:ipc] Failed to persist assistant message:', err);
  }
}

function autoTitleEngineConversation(
  state: AppState,
  convId: string,
  userMessage: string,
): void {
  try {
    if (!state.chatStore.isUnlocked()) return;
    const conv = state.chatStore.getConversation(convId);
    if (conv && !conv.title) {
      const firstLine = userMessage.split('\n')[0].trim();
      const title = firstLine.length > 60
        ? firstLine.slice(0, 57) + '...'
        : firstLine;
      state.chatStore.updateEngineConversationTitle(convId, title);
    }
  } catch (err) {
    console.warn('[engine:ipc] Failed to auto-title conversation:', err);
  }
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerEngineHandlers(state: AppState): void {
  const em = state.engineManager;

  // Set the MCP server path so SDK engines can spawn it
  const mcpPath = app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'dist', 'index.js')
    : path.resolve(app.getAppPath(), 'mcp', 'dist', 'index.js');
  em.setMcpServerPath(mcpPath);

  // Gate MCP path access behind tier check
  em.setMcpGateCheck(() => state.mcpGatekeeper.isAllowed());

  // Initialize all engines (non-blocking — logs warnings for unavailable ones)
  em.initializeAll().then(() => {
    // Seed in-memory model caches from disk (instant, no network)
    try {
      const settings = readSettings();
      if (settings.cached_engine_models) {
        for (const [engineType, cached] of Object.entries(settings.cached_engine_models)) {
          const engine = em.get(engineType as EngineType);
          if (engine?.seedModelCache) {
            engine.seedModelCache(cached.models);
          }
        }
        console.log('[engine:ipc] Seeded model caches from disk');
      }
    } catch (err) {
      console.warn('[engine:ipc] Failed to seed model caches:', err);
    }

    // Background refresh: fetch fresh models ~3s after startup
    setTimeout(async () => {
      const updated: Record<string, { models: EngineModelInfo[]; updatedAt: string }> = {};
      for (const type of ['claude-code', 'codex'] as EngineType[]) {
        try {
          const models = await em.listModels(type, true); // forceRefresh
          if (models.length > 0) {
            updated[type] = { models, updatedAt: new Date().toISOString() };
          }
        } catch { /* non-critical */ }
      }
      if (Object.keys(updated).length > 0) {
        try {
          // Per-engine merge: only update engines that succeeded
          const s = readSettings();
          if (!s.cached_engine_models) s.cached_engine_models = {};
          for (const [type, data] of Object.entries(updated)) {
            s.cached_engine_models[type] = data;
          }
          writeSettings(s);
          console.log('[engine:ipc] Background model cache refresh complete');
        } catch { /* non-critical */ }

        // Push fresh models to frontend so the UI updates without re-opening the picker
        const win = getMainWindow();
        if (win) {
          win.webContents.send('engine:models-refreshed', updated);
        }
      }
    }, 3000);
  }).catch((err) => {
    console.warn('[engine:ipc] Engine initialization error:', err);
  });

  // ── MCP server path ─────────────────────────────────────────────────────

  ipcMain.handle('engine_get_mcp_path', () => {
    if (!state.mcpGatekeeper.isAllowed()) return null;
    return mcpPath;
  });

  ipcMain.handle('engine_get_socket_path', () => {
    if (!state.mcpGatekeeper.isAllowed()) return null;
    return getSocketPath();
  });

  // ── Availability ────────────────────────────────────────────────────────

  ipcMain.handle('engine_check_availability', async () => {
    return em.checkAvailability();
  });

  ipcMain.handle('engine_list_models', async (_e, args) => {
    const { engineType } = args as { engineType: EngineType };
    const models = await em.listModels(engineType);
    // Opportunistically persist to disk for next cold start
    if (models.length > 0) {
      try {
        const s = readSettings();
        if (!s.cached_engine_models) s.cached_engine_models = {};
        s.cached_engine_models[engineType] = { models, updatedAt: new Date().toISOString() };
        writeSettings(s);
      } catch { /* non-critical */ }
    }
    return models;
  });

  // ── Session lifecycle ───────────────────────────────────────────────────

  ipcMain.handle('engine_create_session', async (_e, args) => {
    const { engineType, model, workingDirectory: explicitCwd } = args as {
      engineType: EngineType;
      model?: string;
      workingDirectory?: string;
    };

    // Tier check: ensure CLI agents are allowed
    try {
      const settings = readSettings();
      const caps = settings.cached_tier_capabilities as Record<string, unknown> | undefined;
      if (caps && caps.cli_agents_enabled === false) {
        throw new Error('CLI agents require a Pro plan');
      }
    } catch (err) {
      // If it's our own tier error, rethrow
      if (err instanceof Error && err.message === 'CLI agents require a Pro plan') throw err;
      // Otherwise ignore settings read errors
    }

    // Resolve working directory with same priority as terminal agent:
    // 1. Explicit cwd arg (if provided and exists)
    // 2. default_working_directory from settings (if set and exists)
    // 3. Agent-specific data directory (auto-created)
    let workingDirectory: string;
    if (explicitCwd && fs.existsSync(explicitCwd)) {
      workingDirectory = explicitCwd;
    } else {
      const settings = readSettings();
      if (settings.default_working_directory && fs.existsSync(settings.default_working_directory)) {
        workingDirectory = settings.default_working_directory;
      } else {
        const agentDir = path.join(getDataDir(), 'agent', engineType);
        fs.mkdirSync(agentDir, { recursive: true });
        workingDirectory = agentDir;
      }
    }

    const session = await em.createSession(engineType, { model, workingDirectory });

    // Persist session metadata if chat store is unlocked
    try {
      if (state.chatStore.isUnlocked()) {
        state.chatStore.saveEngineSession({
          id: session.id,
          engineType: session.engineType,
          externalId: session.externalId,
          model: session.model,
          workingDirectory: session.workingDirectory,
        });
      }
    } catch (err) {
      console.warn('[engine:ipc] Failed to persist engine session:', err);
    }

    return session;
  });

  ipcMain.handle('engine_destroy_session', async (_e, args) => {
    const { engineType, sessionId } = args as {
      engineType: EngineType;
      sessionId: string;
    };
    activeAbortControllers.delete(sessionId);
    await em.destroySession(engineType, sessionId);

    // Remove from persisted sessions
    try {
      if (state.chatStore.isUnlocked()) {
        state.chatStore.deleteEngineSession(sessionId);
      }
    } catch (err) {
      console.warn('[engine:ipc] Failed to remove persisted engine session:', err);
    }
  });

  ipcMain.handle('engine_list_sessions', async (_e, args) => {
    const { engineType } = (args ?? {}) as { engineType?: EngineType };
    if (engineType) {
      return em.listSessions(engineType);
    }
    return em.listAllSessions();
  });

  // ── Persisted sessions ─────────────────────────────────────────────────

  ipcMain.handle('engine_list_persisted_sessions', async (_e, args) => {
    const { engineType } = (args ?? {}) as { engineType?: string };
    try {
      if (!state.chatStore.isUnlocked()) return [];
      return state.chatStore.listEngineSessions(engineType);
    } catch {
      return [];
    }
  });

  ipcMain.handle('engine_resume_session', async (_e, args) => {
    const { engineType, sessionId } = args as {
      engineType: EngineType;
      sessionId: string;
    };
    try {
      const session = await em.resumeSession(engineType, sessionId);

      // Update persisted metadata
      if (state.chatStore.isUnlocked()) {
        state.chatStore.saveEngineSession({
          id: session.id,
          engineType: session.engineType,
          externalId: session.externalId,
          model: session.model,
          workingDirectory: session.workingDirectory,
        });
      }

      return session;
    } catch (err) {
      // Session is stale — remove from persistence
      console.warn(`[engine:ipc] Failed to resume session ${sessionId}, cleaning up:`, err);
      try {
        if (state.chatStore.isUnlocked()) {
          state.chatStore.deleteEngineSession(sessionId);
        }
      } catch {
        // ignore
      }
      throw err;
    }
  });

  // ── Session updates ────────────────────────────────────────────────────

  ipcMain.handle('engine_update_session', async (_e, args) => {
    const { engineType, sessionId, updates } = args as {
      engineType: EngineType;
      sessionId: string;
      updates: { model?: string };
    };
    await em.updateSession(engineType, sessionId, updates);

    // Update persistence
    try {
      if (state.chatStore.isUnlocked()) {
        const existing = state.chatStore.getEngineSession(sessionId);
        if (existing) {
          state.chatStore.saveEngineSession({
            id: existing.id,
            engineType: existing.engineType,
            externalId: existing.externalId ?? undefined,
            model: updates.model ?? existing.model ?? undefined,
            workingDirectory: existing.workingDirectory ?? undefined,
          });
        }
      }
    } catch (err) {
      console.warn('[engine:ipc] Failed to update persisted session:', err);
    }
  });

  // ── Messaging ───────────────────────────────────────────────────────────

  ipcMain.handle('engine_send_message', async (_e, args) => {
    const { engineType, sessionId, message } = args as {
      engineType: EngineType;
      sessionId: string;
      message: string;
    };

    const mainWindow = getMainWindow();
    const abortController = new AbortController();
    activeAbortControllers.set(sessionId, abortController);

    console.log(`[engine:ipc] send_message engine=${engineType} session=${sessionId}`);

    // Get or create the conversation for persistence
    const session = state.chatStore.isUnlocked()
      ? state.chatStore.getEngineSession(sessionId)
      : null;
    const convId = getOrCreateEngineConversation(
      state, sessionId, engineType, session?.model ?? undefined,
    );

    // Persist the user message
    if (convId) {
      persistEngineUserMessage(state, convId, message);
      autoTitleEngineConversation(state, convId, message);
    }

    // Collect assistant blocks during the turn
    const turnBlocks: MessageBlock[] = [];
    let assistantPersisted = false;

    try {
      await em.sendMessage(
        engineType,
        sessionId,
        message,
        (event: ChatEngineEvent) => {
          // Collect blocks for persistence
          collectBlock(turnBlocks, event);

          // Forward every engine event to the renderer
          mainWindow?.webContents.send('ai:engine-stream', {
            sessionId,
            engineType,
            event,
          });

          // On done, persist the assistant message
          if (event.type === 'done' && convId && turnBlocks.length > 0 && !assistantPersisted) {
            assistantPersisted = true;
            persistEngineAssistantMessage(state, convId, [...turnBlocks]);
          }
        },
        abortController.signal,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine:ipc] send_message failed: ${errorMsg}`);

      // Persist any partial assistant blocks (if not already persisted by done event)
      if (convId && turnBlocks.length > 0 && !assistantPersisted) {
        assistantPersisted = true;
        persistEngineAssistantMessage(state, convId, [...turnBlocks]);
      }

      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'error', message: errorMsg } as ChatEngineEvent,
      });
      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'done' } as ChatEngineEvent,
      });
    } finally {
      activeAbortControllers.delete(sessionId);
    }
  });

  // ── Edit / Retry ────────────────────────────────────────────────────────

  ipcMain.handle('engine_edit_message', async (_e, args) => {
    const { engineType, sessionId, messageIndex, newMessage } = args as {
      engineType: EngineType;
      sessionId: string;
      messageIndex: number;
      newMessage: string;
    };

    const mainWindow = getMainWindow();
    const abortController = new AbortController();
    activeAbortControllers.set(sessionId, abortController);

    console.log(`[engine:ipc] edit_message engine=${engineType} session=${sessionId} from=${messageIndex}`);

    // Find the conversation linked to this session
    const convId = state.chatStore.isUnlocked()
      ? state.chatStore.findConversationByEngineSession(sessionId)?.id ?? null
      : null;

    // Calculate turns to rollback and truncate persisted messages
    let turnsToRollback = 0;
    if (convId) {
      try {
        const persisted = state.chatStore.getEngineMessages(convId);
        // Count user messages from messageIndex to end = turns to rollback
        for (let i = messageIndex; i < persisted.length; i++) {
          if (persisted[i].role === 'user') turnsToRollback++;
        }
        // Truncate: keep only messages before messageIndex
        state.chatStore.deleteMessagesFrom(convId, messageIndex);
      } catch (err) {
        console.warn('[engine:ipc] Failed to truncate persisted messages:', err);
      }
    }

    // Prepare the engine (rollback or reset)
    try {
      await em.prepareForEdit(engineType, sessionId, turnsToRollback);
    } catch (err) {
      console.warn('[engine:ipc] prepareForEdit failed:', err);
    }

    // Persist the new user message
    if (convId) {
      persistEngineUserMessage(state, convId, newMessage);
    }

    // Send the message (same streaming flow as engine_send_message)
    const turnBlocks: MessageBlock[] = [];
    let assistantPersisted = false;

    try {
      await em.sendMessage(
        engineType,
        sessionId,
        newMessage,
        (event: ChatEngineEvent) => {
          collectBlock(turnBlocks, event);
          mainWindow?.webContents.send('ai:engine-stream', {
            sessionId,
            engineType,
            event,
          });
          if (event.type === 'done' && convId && turnBlocks.length > 0 && !assistantPersisted) {
            assistantPersisted = true;
            persistEngineAssistantMessage(state, convId, [...turnBlocks]);
          }
        },
        abortController.signal,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine:ipc] edit_message failed: ${errorMsg}`);

      if (convId && turnBlocks.length > 0 && !assistantPersisted) {
        assistantPersisted = true;
        persistEngineAssistantMessage(state, convId, [...turnBlocks]);
      }

      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'error', message: errorMsg } as ChatEngineEvent,
      });
      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'done' } as ChatEngineEvent,
      });
    } finally {
      activeAbortControllers.delete(sessionId);
    }
  });

  ipcMain.handle('engine_retry_message', async (_e, args) => {
    const { engineType, sessionId, userMessageIndex } = args as {
      engineType: EngineType;
      sessionId: string;
      userMessageIndex: number;
    };

    const mainWindow = getMainWindow();
    const abortController = new AbortController();
    activeAbortControllers.set(sessionId, abortController);

    console.log(`[engine:ipc] retry_message engine=${engineType} session=${sessionId} from=${userMessageIndex}`);

    // Find the conversation and extract the original user message
    const convId = state.chatStore.isUnlocked()
      ? state.chatStore.findConversationByEngineSession(sessionId)?.id ?? null
      : null;

    let originalMessage = '';
    let turnsToRollback = 0;

    if (convId) {
      try {
        const persisted = state.chatStore.getEngineMessages(convId);
        // Extract user message text at the given index
        const userMsg = persisted[userMessageIndex];
        if (userMsg?.role === 'user') {
          const textBlock = userMsg.blocks.find(
            (b) => (b as { type: string }).type === 'text',
          ) as { type: 'text'; content: string } | undefined;
          originalMessage = textBlock?.content ?? '';
        }
        // Count user messages from userMessageIndex to end = turns to rollback
        for (let i = userMessageIndex; i < persisted.length; i++) {
          if (persisted[i].role === 'user') turnsToRollback++;
        }
        // Truncate: keep only messages before userMessageIndex
        state.chatStore.deleteMessagesFrom(convId, userMessageIndex);
      } catch (err) {
        console.warn('[engine:ipc] Failed to process retry:', err);
      }
    }

    if (!originalMessage) {
      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'error', message: 'Could not find original message to retry' } as ChatEngineEvent,
      });
      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'done' } as ChatEngineEvent,
      });
      activeAbortControllers.delete(sessionId);
      return;
    }

    // Prepare the engine (rollback or reset)
    try {
      await em.prepareForEdit(engineType, sessionId, turnsToRollback);
    } catch (err) {
      console.warn('[engine:ipc] prepareForEdit failed:', err);
    }

    // Persist the user message (re-add)
    if (convId) {
      persistEngineUserMessage(state, convId, originalMessage);
    }

    // Send the message
    const turnBlocks: MessageBlock[] = [];
    let assistantPersisted = false;

    try {
      await em.sendMessage(
        engineType,
        sessionId,
        originalMessage,
        (event: ChatEngineEvent) => {
          collectBlock(turnBlocks, event);
          mainWindow?.webContents.send('ai:engine-stream', {
            sessionId,
            engineType,
            event,
          });
          if (event.type === 'done' && convId && turnBlocks.length > 0 && !assistantPersisted) {
            assistantPersisted = true;
            persistEngineAssistantMessage(state, convId, [...turnBlocks]);
          }
        },
        abortController.signal,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine:ipc] retry_message failed: ${errorMsg}`);

      if (convId && turnBlocks.length > 0 && !assistantPersisted) {
        assistantPersisted = true;
        persistEngineAssistantMessage(state, convId, [...turnBlocks]);
      }

      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'error', message: errorMsg } as ChatEngineEvent,
      });
      mainWindow?.webContents.send('ai:engine-stream', {
        sessionId,
        engineType,
        event: { type: 'done' } as ChatEngineEvent,
      });
    } finally {
      activeAbortControllers.delete(sessionId);
    }
  });

  // ── Load engine conversation messages ───────────────────────────────────

  ipcMain.handle('engine_load_conversation_messages', async (_e, args) => {
    const { conversationId } = args as { conversationId: string };
    try {
      if (!state.chatStore.isUnlocked()) return [];
      return state.chatStore.getEngineMessages(conversationId);
    } catch (err) {
      console.warn('[engine:ipc] Failed to load engine messages:', err);
      return [];
    }
  });

  // ── Find conversation by engine session ID ──────────────────────────────

  ipcMain.handle('engine_find_conversation', async (_e, args) => {
    const { engineSessionId } = args as { engineSessionId: string };
    try {
      if (!state.chatStore.isUnlocked()) return null;
      return state.chatStore.findConversationByEngineSession(engineSessionId);
    } catch {
      return null;
    }
  });

  // ── Control ─────────────────────────────────────────────────────────────

  ipcMain.handle('engine_cancel_turn', async (_e, args) => {
    const { engineType, sessionId } = args as {
      engineType: EngineType;
      sessionId: string;
    };
    // Abort local controller
    const controller = activeAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      activeAbortControllers.delete(sessionId);
    }
    // Deny any pending tool approvals so blocked tool calls unblock immediately
    state.toolApproval.denyAllPending();
    // Also tell the engine
    await em.cancelTurn(engineType, sessionId);
  });

  ipcMain.handle('engine_respond_approval', async (_e, args) => {
    const { engineType, sessionId, approvalId, approved } = args as {
      engineType: EngineType;
      sessionId: string;
      approvalId: string;
      approved: boolean;
    };
    await em.respondToApproval(engineType, sessionId, approvalId, approved);
  });
}

/**
 * Collect message blocks from engine events for persistence.
 * Mirrors the frontend streaming block accumulation logic.
 */
function collectBlock(blocks: MessageBlock[], event: ChatEngineEvent): void {
  switch (event.type) {
    case 'text_delta': {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'text') {
        (last as { type: 'text'; content: string }).content += event.content;
      } else {
        blocks.push({ type: 'text', content: event.content });
      }
      break;
    }
    case 'tool_start':
      blocks.push({
        type: 'tool_call',
        id: event.id,
        name: event.name,
        input: event.input,
        status: 'running',
      });
      break;
    case 'tool_end': {
      const idx = blocks.findIndex(
        (b) => b.type === 'tool_call' && b.id === event.id,
      );
      if (idx !== -1) {
        const b = blocks[idx] as { type: 'tool_call'; id: string; name: string; input: unknown; output?: string; status: string };
        b.output = event.output;
        b.status = event.isError ? 'error' : 'success';
      }
      break;
    }
    case 'file_edit':
      blocks.push({ type: 'file_edit', path: event.path, diff: event.diff });
      break;
    case 'file_create':
      blocks.push({ type: 'file_create', path: event.path, content: event.content });
      break;
    case 'file_delete':
      blocks.push({ type: 'file_delete', path: event.path });
      break;
    case 'command_start':
      blocks.push({
        type: 'command',
        id: event.id,
        command: event.command,
        output: '',
        status: 'running',
      } as MessageBlock);
      break;
    case 'command_output': {
      const cmdBlock = blocks.find(
        (b) => b.type === 'command' && b.id === event.id,
      );
      if (cmdBlock && cmdBlock.type === 'command') {
        (cmdBlock as { output: string }).output += event.content;
      }
      break;
    }
    case 'command_end': {
      const cmd = blocks.find(
        (b) => b.type === 'command' && b.id === event.id,
      );
      if (cmd && cmd.type === 'command') {
        (cmd as { exitCode?: number; status: string }).exitCode = event.exitCode;
        (cmd as { exitCode?: number; status: string }).status = event.exitCode === 0 ? 'success' : 'error';
      }
      break;
    }
    case 'approval_request':
      blocks.push({
        type: 'approval',
        id: event.id,
        description: event.description,
        command: event.command,
        status: 'pending',
      });
      break;
    case 'error':
      blocks.push({ type: 'error', message: event.message });
      break;
    // 'usage', 'done', 'tool_output' — no block to persist
  }
}
