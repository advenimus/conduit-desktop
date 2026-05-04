/**
 * Engine IPC handlers — expose the unified engine abstraction to the renderer.
 *
 * These handlers run alongside the existing ai_* handlers.  The built-in
 * engine continues to use the old ai_* IPC path; these handlers are for
 * the SDK engines (Claude Code, Codex).
 */

import { ipcMain, app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AppState } from '../services/state.js';
import type { EngineType, ChatEngineEvent, EngineModelInfo } from '../services/ai/engines/engine.js';
import { readSettings, writeSettings } from './settings.js';
import { getSocketPath } from '../ipc-server/server.js';
import { getDataDir, getEnvConfig } from '../services/env-config.js';

/**
 * Write the canonical project-scoped `.mcp.json` into the in-app agent's
 * working directory. Called every time we use an auto-created agent dir, so
 * the file always points at the current build's MCP — old paths from
 * previous installs (e.g. the predecessor `~/Github/conduit/` repo) get
 * overwritten transparently. Only ever touches conduit-managed agent dirs;
 * never user-chosen working directories.
 */
function writeAgentMcpConfig(agentDir: string, mcpPath: string): void {
  const config = {
    mcpServers: {
      conduit: {
        type: 'stdio',
        command: 'node',
        args: [mcpPath],
        env: {
          CONDUIT_SOCKET_PATH: getSocketPath(),
          CONDUIT_ENV: getEnvConfig().environment,
          CONDUIT_INTERNAL_AGENT: '1',
        },
      },
    },
  };
  try {
    fs.writeFileSync(
      path.join(agentDir, '.mcp.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  } catch (err) {
    console.warn('[engine:ipc] Failed to write agent .mcp.json:', err);
  }
}

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

/** Active abort controllers for engine turns, keyed by sessionId. */
const activeAbortControllers = new Map<string, AbortController>();

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

  ipcMain.handle('engine_open_install_docs', async (_e, args: { engineType: EngineType }) => {
    const url = args.engineType === 'claude-code'
      ? 'https://code.claude.com/docs/en/setup'
      : 'https://github.com/openai/codex#installing-and-running-codex-cli';
    await shell.openExternal(url);
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
        // Refresh the project-scoped MCP config so it always points at the
        // current build — heals stale paths from previous installs.
        writeAgentMcpConfig(agentDir, mcpPath);
        workingDirectory = agentDir;
      }
    }

    const session = await em.createSession(engineType, { model, workingDirectory });
    return session;
  });

  ipcMain.handle('engine_destroy_session', async (_e, args) => {
    const { engineType, sessionId } = args as {
      engineType: EngineType;
      sessionId: string;
    };
    activeAbortControllers.delete(sessionId);
    await em.destroySession(engineType, sessionId);
  });

  ipcMain.handle('engine_list_sessions', async (_e, args) => {
    const { engineType } = (args ?? {}) as { engineType?: EngineType };
    if (engineType) {
      return em.listSessions(engineType);
    }
    return em.listAllSessions();
  });

  // ── Session updates ────────────────────────────────────────────────────

  ipcMain.handle('engine_update_session', async (_e, args) => {
    const { engineType, sessionId, updates } = args as {
      engineType: EngineType;
      sessionId: string;
      updates: { model?: string };
    };
    await em.updateSession(engineType, sessionId, updates);
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

    try {
      await em.sendMessage(
        engineType,
        sessionId,
        message,
        (event: ChatEngineEvent) => {
          // Forward every engine event to the renderer
          mainWindow?.webContents.send('ai:engine-stream', {
            sessionId,
            engineType,
            event,
          });
        },
        abortController.signal,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine:ipc] send_message failed: ${errorMsg}`);

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

    // Prepare the engine (reset session state from this point)
    try {
      await em.prepareForEdit(engineType, sessionId, 0);
    } catch (err) {
      console.warn('[engine:ipc] prepareForEdit failed:', err);
    }

    try {
      await em.sendMessage(
        engineType,
        sessionId,
        newMessage,
        (event: ChatEngineEvent) => {
          mainWindow?.webContents.send('ai:engine-stream', {
            sessionId,
            engineType,
            event,
          });
        },
        abortController.signal,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine:ipc] edit_message failed: ${errorMsg}`);

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
    const { engineType, sessionId, userMessage } = args as {
      engineType: EngineType;
      sessionId: string;
      userMessage: string;
    };

    const mainWindow = getMainWindow();
    const abortController = new AbortController();
    activeAbortControllers.set(sessionId, abortController);

    console.log(`[engine:ipc] retry_message engine=${engineType} session=${sessionId}`);

    // Reset engine session state before re-running the user message.
    try {
      await em.prepareForEdit(engineType, sessionId, 0);
    } catch (err) {
      console.warn('[engine:ipc] prepareForEdit failed:', err);
    }

    try {
      await em.sendMessage(
        engineType,
        sessionId,
        userMessage,
        (event: ChatEngineEvent) => {
          mainWindow?.webContents.send('ai:engine-stream', {
            sessionId,
            engineType,
            event,
          });
        },
        abortController.signal,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[engine:ipc] retry_message failed: ${errorMsg}`);

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
