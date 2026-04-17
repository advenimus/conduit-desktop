/**
 * IPC handlers for web session management.
 *
 * Registers all web_session_* handlers that map to WebSessionManager methods.
 * The channel names match the original Tauri commands so the frontend
 * invoke() calls work without modification.
 */

import { ipcMain, dialog, shell } from 'electron';
import { AppState } from '../services/state.js';

export function registerWebHandlers(): void {
  const state = AppState.getInstance();

  // ── Auto-autofill on page load ───────────────────────────────
  state.webManager.onPageLoaded = async (sessionId: string, entryId: string) => {
    try {
      // Resolve credentials for the entry
      const cred = state.getActiveVault().resolveCredential(entryId);
      if (!cred || (!cred.username && !cred.password)) {
        console.log(`[autofill] auto-autofill skipped for session ${sessionId.slice(0, 8)} — no credentials`);
        return;
      }

      console.log(`[autofill] auto-autofill triggered for session ${sessionId.slice(0, 8)} entry=${entryId.slice(0, 8)}`);

      // Read autofill config (custom selectors) if available — but don't require autofill.enabled
      let autofillConfig: { usernameSelector?: string; passwordSelector?: string; submitSelector?: string; multiStepLogin?: boolean } = {};
      try {
        const entry = state.getActiveVault().getEntry(entryId);
        const config = (entry.config ?? {}) as { autofill?: { usernameSelector?: string; passwordSelector?: string; submitSelector?: string; multiStepLogin?: boolean } };
        if (config.autofill) {
          autofillConfig = {
            usernameSelector: config.autofill.usernameSelector,
            passwordSelector: config.autofill.passwordSelector,
            submitSelector: config.autofill.submitSelector,
            multiStepLogin: config.autofill.multiStepLogin,
          };
        }
      } catch {
        // Entry not found — proceed with discovery-only
      }

      const result = await state.webManager.executeAutofill(sessionId, cred.username, cred.password, autofillConfig);
      console.log(`[autofill] auto-autofill result: success=${result.success} phase=${result.phase} filled=${JSON.stringify(result.fieldsFilled)}${result.error ? ' error=' + result.error : ''}`);

      // Notify the renderer so the toolbar can show feedback
      const mainWindow = state.getMainWindow();
      if (mainWindow) {
        mainWindow.webContents.send('web:autofill-result', {
          sessionId,
          success: result.success,
          fieldsFilled: result.fieldsFilled,
          error: result.error,
        });
      }
    } catch (err) {
      console.error(`[autofill] auto-autofill error for session ${sessionId.slice(0, 8)}:`, err);
    }
  };

  ipcMain.handle('web_session_create', async (_e, args) => {
    const { url, userAgent, ignoreCertErrors, entryId, engine } = args ?? {};
    const sessionId = state.webManager.createSession(url, userAgent, ignoreCertErrors, entryId, engine);

    // Register in MCP connection registry so AI/MCP tools can see UI-opened sessions
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch { /* use raw url */ }
    state.mcpConnections.set(sessionId, {
      session_id: sessionId,
      name: `Web ${hostname}`,
      connection_type: 'web',
      host: url,
      port: null,
      status: 'connected',
      created_at: Date.now(),
    });

    return sessionId;
  });

  ipcMain.handle('web_session_create_webview', async (_e, args) => {
    const { sessionId, x, y, width, height } = args ?? {};
    await state.webManager.createWebview(sessionId, x, y, width, height);
  });

  ipcMain.handle('web_session_close', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.mcpConnections.delete(sessionId);
    state.webManager.closeSession(sessionId);
  });

  ipcMain.handle('web_session_hide', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.hideSession(sessionId);
  });

  ipcMain.handle('web_session_hide_all', async () => {
    state.webManager.hideAllSessions();
  });

  ipcMain.handle('web_session_capture_page', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.capturePage(sessionId);
  });

  ipcMain.handle('web_session_capture_and_hide', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.captureAndHide(sessionId);
  });

  ipcMain.handle('web_session_show', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.showSession(sessionId);
  });

  ipcMain.handle('web_session_accept_cert', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.acceptCert(sessionId);
  });

  ipcMain.handle('web_session_navigate', async (_e, args) => {
    const { sessionId, url } = args ?? {};
    state.webManager.navigate(sessionId, url);
  });

  ipcMain.handle('web_session_update_position', async (_e, args) => {
    const { sessionId, x, y, width, height } = args ?? {};
    state.webManager.updateBounds(sessionId, x, y, width, height);
  });

  ipcMain.handle('web_session_screenshot', async (_e, args) => {
    const { sessionId } = args ?? {};
    const result = await state.webManager.screenshot(sessionId);
    return result.image;
  });

  ipcMain.handle('web_session_read_content', async (_e, args) => {
    const { sessionId, selector, format } = args ?? {};
    return state.webManager.readContent(sessionId, selector, format);
  });

  ipcMain.handle('web_session_get_url', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.getUrl(sessionId);
  });

  ipcMain.handle('web_session_get_title', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.getTitle(sessionId);
  });

  ipcMain.handle('web_session_list', async () => {
    return state.webManager.listSessions();
  });

  ipcMain.handle('web_session_autofill', async (_e, args) => {
    const { sessionId, entryId } = args ?? {};
    console.log(`[autofill] IPC web_session_autofill: sessionId=${sessionId?.slice(0, 8)} entryId=${entryId?.slice(0, 8)}`);

    // Get entry to read config and resolve credentials
    let entry;
    try {
      entry = state.getActiveVault().getEntry(entryId);
    } catch (err) {
      console.error(`[autofill] entry lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, phase: 'config', fieldsFilled: [], error: 'Entry not found or vault locked' };
    }

    const config = (entry.config ?? {}) as { autofill?: { enabled?: boolean; usernameSelector?: string; passwordSelector?: string; submitSelector?: string; multiStepLogin?: boolean; loginUrlPattern?: string } };
    if (!config.autofill?.enabled) {
      console.log(`[autofill] autofill not enabled for entry ${entryId?.slice(0, 8)}`);
      return { success: false, phase: 'config', fieldsFilled: [], error: 'Autofill is not enabled for this entry' };
    }

    // Check URL pattern match
    if (config.autofill.loginUrlPattern) {
      try {
        const currentUrl = state.webManager.getUrl(sessionId);
        const pattern = new RegExp(config.autofill.loginUrlPattern);
        const matches = pattern.test(currentUrl);
        console.log(`[autofill] URL pattern check: pattern=${config.autofill.loginUrlPattern} url=${currentUrl} matches=${matches}`);
        if (!matches) {
          return { success: false, phase: 'url_match', fieldsFilled: [], error: 'Current URL does not match login URL pattern' };
        }
      } catch {
        console.log(`[autofill] invalid loginUrlPattern regex, skipping check`);
      }
    }

    // Resolve credentials
    const cred = state.getActiveVault().resolveCredential(entryId);
    if (!cred || (!cred.username && !cred.password)) {
      console.error(`[autofill] no credentials resolved for entry ${entryId?.slice(0, 8)}`);
      return { success: false, phase: 'credentials', fieldsFilled: [], error: 'No credentials configured for this entry' };
    }
    console.log(`[autofill] credentials resolved: hasUsername=${!!cred.username} hasPassword=${!!cred.password}`);

    const result = await state.webManager.executeAutofill(sessionId, cred.username, cred.password, {
      usernameSelector: config.autofill.usernameSelector,
      passwordSelector: config.autofill.passwordSelector,
      submitSelector: config.autofill.submitSelector,
      multiStepLogin: config.autofill.multiStepLogin,
    });
    console.log(`[autofill] executeAutofill result: success=${result.success} phase=${result.phase} filled=${JSON.stringify(result.fieldsFilled)}${result.error ? ' error=' + result.error : ''}`);
    return result;
  });

  ipcMain.handle('web_session_type', async (_e, args: { sessionId: string; text: string }) => {
    await state.webManager.typeText(args.sessionId, args.text);
  });

  ipcMain.handle('web_session_send_key', async (_e, args: {
    sessionId: string;
    key: string;
    modifiers?: string[];
    action?: 'press' | 'down' | 'up';
  }) => {
    state.webManager.sendKey(args.sessionId, args.key, args.modifiers ?? [], args.action ?? 'press');
  });

  // ── Selector picker ───────────────────────────────────────────
  ipcMain.handle('web_session_start_picker', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.startSelectorPicker(sessionId);
  });

  ipcMain.handle('web_session_cancel_picker', async (_e, args) => {
    const { sessionId } = args ?? {};
    await state.webManager.cancelSelectorPicker(sessionId);
  });

  ipcMain.handle('web_session_save_autofill_selectors', async (_e, args) => {
    const { entryId, selectors } = args ?? {};
    const { usernameSelector, passwordSelector, submitSelector } = selectors ?? {};

    const vault = state.getActiveVault();
    const entry = vault.getEntryMeta(entryId);
    const existingConfig = (entry.config ?? {}) as Record<string, unknown>;
    const existingAutofill = (existingConfig.autofill ?? {}) as Record<string, unknown>;

    const newAutofill = {
      ...existingAutofill,
      enabled: true,
      ...(usernameSelector !== undefined && { usernameSelector }),
      ...(passwordSelector !== undefined && { passwordSelector }),
      ...(submitSelector !== undefined && { submitSelector }),
    };

    vault.updateEntry(entryId, {
      config: { ...existingConfig, autofill: newAutofill },
    });

    return newAutofill;
  });

  ipcMain.handle('web_session_get_autofill_config', async (_e, args) => {
    const { entryId } = args ?? {};
    try {
      const entry = state.getActiveVault().getEntryMeta(entryId);
      const config = (entry.config ?? {}) as { autofill?: { enabled?: boolean; loginUrlPattern?: string } };
      return config.autofill ?? null;
    } catch {
      return null;
    }
  });

  // ── Tab management ────────────────────────────────────────────

  ipcMain.handle('web_session_create_tab', async (_e, args) => {
    const { sessionId, url } = args ?? {};
    const tabId = state.webManager.createTab(sessionId, url);
    return { tabId };
  });

  ipcMain.handle('web_session_close_tab', async (_e, args) => {
    const { sessionId, tabId } = args ?? {};
    return state.webManager.closeTab(sessionId, tabId);
  });

  ipcMain.handle('web_session_switch_tab', async (_e, args) => {
    const { sessionId, tabId } = args ?? {};
    state.webManager.switchTab(sessionId, tabId);
  });

  ipcMain.handle('web_session_go_back', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.goBack(sessionId);
  });

  ipcMain.handle('web_session_go_forward', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.goForward(sessionId);
  });

  ipcMain.handle('web_session_reload', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.reload(sessionId);
  });

  ipcMain.handle('web_session_stop', async (_e, args) => {
    const { sessionId } = args ?? {};
    state.webManager.stopLoading(sessionId);
  });

  ipcMain.handle('web_session_reorder_tab', async (_e, args) => {
    const { sessionId, fromIndex, toIndex } = args ?? {};
    state.webManager.reorderTab(sessionId, fromIndex, toIndex);
  });

  ipcMain.handle('web_session_get_tabs', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.getTabList(sessionId);
  });

  ipcMain.handle('web_session_get_original_url', async (_e, args) => {
    const { sessionId } = args ?? {};
    return state.webManager.getOriginalUrl(sessionId);
  });

  // ── Download handlers ──────────────────────────────────────────

  ipcMain.handle('web_download_respond', async (_e, args) => {
    const { downloadId, action } = args as { downloadId: string; action: 'open' | 'save_as' | 'cancel' };

    if (action === 'cancel') {
      state.webManager.cancelDownload(downloadId);
      return;
    }

    if (action === 'open') {
      state.webManager.resumeDownloadForOpen(downloadId);
      return;
    }

    if (action === 'save_as') {
      const pending = state.webManager.getPendingDownload(downloadId);
      if (!pending) return;

      const win = state.getMainWindow();
      if (!win) return;

      const result = await dialog.showSaveDialog(win, {
        title: 'Save File',
        defaultPath: pending.filename,
      });

      if (result.canceled || !result.filePath) {
        state.webManager.cancelDownload(downloadId);
        return;
      }

      state.webManager.resumeDownloadForSave(downloadId, result.filePath);
    }
  });

  ipcMain.handle('web_download_open_file', async (_e, args) => {
    const { filePath } = args as { filePath: string };
    const errMsg = await shell.openPath(filePath);
    if (errMsg) throw new Error(errMsg);
  });
}
