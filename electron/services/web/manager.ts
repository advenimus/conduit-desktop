/**
 * Web session manager using Electron's WebContentsView.
 *
 * This is the PRIMARY motivation for the Tauri-to-Electron migration.
 * WebContentsView.setBounds() works correctly on all platforms, unlike
 * Tauri's child webview Y-positioning bug on macOS (#9611).
 *
 * Port of crates/conduit-web/src/session.rs + src-tauri/src/commands/web.rs
 */

import { BrowserWindow, WebContentsView, app, session as electronSession, shell, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import { WebSession, type WebSessionInfo } from './session.js';
import { WebTab, type WebTabInfo } from './tab.js';
import type { DiscoveryResult, FillResult } from './autofill.js';
import type { PickerResult } from './picker.js';
import { resolveWebEngine, type WebEngineType } from './engines/factory.js';
import { WebView2Session } from './webview2-session.js';
import { readSettings } from '../../ipc/settings.js';
import * as autofill from './web-autofill-handler.js';
import * as interaction from './web-interaction.js';

/** State for a pending or active download across both engines */
export interface PendingDownload {
  downloadId: string;
  sessionId: string;
  tabId: string;
  filename: string;
  totalBytes: number;
  mimeType: string;
  url: string;
  engine: 'chromium' | 'webview2';
  /** User's chosen save path (for Save As — file is moved from temp after completion) */
  userSavePath?: string;
  /** Action the user chose */
  action?: 'open' | 'save';
  /** If the download completed before the user chose an action, store the temp path here */
  completedPath?: string;
  /** Chromium DownloadItem reference */
  electronItem?: Electron.DownloadItem;
  /** WebView2 session reference for sending pipe commands */
  wv2SessionRef?: WebView2Session;
}

/** Maximum number of sub-tabs per session */
const MAX_TABS_PER_SESSION = 12;

export class WebSessionManager {
  private sessions = new Map<string, WebSession>();
  /** WebView2 sessions — maps sessionId to the ACTIVE tab's WebView2Session.
   *  Updated when switching/closing tabs. All existing code that does
   *  wv2Sessions.get(sessionId) automatically gets the active tab's session. */
  private wv2Sessions = new Map<string, WebView2Session>();
  /** Per-tab WebView2 sessions — maps tabId to its own WebView2Session.
   *  Each tab in a WebView2 session gets its own helper process. */
  private wv2TabMap = new Map<string, WebView2Session>();
  /** Stored move/resize resync handlers per session (for cleanup on close). */
  private wv2ResyncHandlers = new Map<string, () => void>();
  private getMainWindow: () => BrowserWindow | null;

  /** Callback invoked when a web session's page finishes loading (for auto-autofill). */
  onPageLoaded: ((sessionId: string, entryId: string) => void) | null = null;

  /** Pending/active downloads keyed by downloadId */
  private pendingDownloads = new Map<string, PendingDownload>();
  /** Reverse-lookup: webContents.id → { sessionId, tabId } for matching will-download events */
  private webContentsIdMap = new Map<number, { sessionId: string; tabId: string }>();
  /** Whether the global will-download handler has been registered */
  private downloadHandlerRegistered = false;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  /** Convert CSS pixel bounds from the renderer to native DIP bounds.
   *  When the main window has a non-1.0 zoom factor, CSS pixels ≠ DIP.
   *  native_DIP = css_pixels × zoomFactor */
  private cssToDip(x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } {
    const mainWindow = this.getMainWindow();
    const zf = mainWindow ? mainWindow.webContents.getZoomFactor() : 1;
    return {
      x: Math.round(x * zf),
      y: Math.round(y * zf),
      width: Math.round(width * zf),
      height: Math.round(height * zf),
    };
  }

  /** Convert content-area-relative DIP bounds to absolute screen coordinates.
   *  Uses getContentBounds() which returns the screen position of the web content
   *  area (below title bar AND native menu bar on Windows). */
  private dipToScreen(dip: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return dip;
    const contentBounds = mainWindow.getContentBounds();
    return {
      x: contentBounds.x + dip.x,
      y: contentBounds.y + dip.y,
      width: dip.width,
      height: dip.height,
    };
  }

  // ──────────────────────────────────────────────────────────────
  //  Session lifecycle
  // ──────────────────────────────────────────────────────────────

  /** Create a session (data only, no view yet). */
  createSession(url: string, userAgent?: string, ignoreCertErrors?: boolean, entryId?: string, engine?: WebEngineType): string {
    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    // Resolve engine: per-entry override → global default → 'auto'
    const globalDefault = readSettings().default_web_engine ?? 'auto';
    console.log(`[WebMgr] createSession engine: param=${engine}, globalDefault=${globalDefault}, using=${engine ?? globalDefault}`);
    const resolvedEngine = resolveWebEngine(engine ?? globalDefault);

    const id = randomUUID();
    const session = new WebSession(id, url, userAgent, ignoreCertErrors, entryId, resolvedEngine);
    this.sessions.set(id, session);
    return id;
  }

  /** Create the WebContentsView for an existing session and add it to the main window.
   *  This creates the first tab if none exist. */
  async createWebview(
    sessionId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<void> {
    const session = this.getSession(sessionId);

    // ── WebView2 engine (Windows-only, for M365 SSO) ──
    if (session.engine === 'webview2') {
      if (this.wv2Sessions.has(sessionId)) {
        // Already created — show and update bounds
        const wv2 = this.wv2Sessions.get(sessionId)!;
        wv2.show();
        const dipBounds = this.cssToDip(x, y, width, height);
        wv2.setBounds(dipBounds, this.dipToScreen(dipBounds));
        return;
      }

      const mainWindow = this.getMainWindow();
      if (!mainWindow) throw new Error('Main window not available');

      const hwnd = mainWindow.getNativeWindowHandle();
      const dipBounds = this.cssToDip(x, y, width, height);

      // Create a virtual tab for the initial page
      const virtualTabId = randomUUID();
      const virtualTab = new WebTab(virtualTabId, session.originalUrl);
      session.addTab(virtualTab, true);

      // Spawn the WebView2 helper for this tab
      const wv2 = new WebView2Session(virtualTabId);
      // Register immediately to prevent double-creation from React StrictMode
      this.wv2Sessions.set(sessionId, wv2);
      this.wv2TabMap.set(virtualTabId, wv2);

      // Wire events for this tab
      this.wireWv2TabEvents(sessionId, virtualTab, wv2, mainWindow);

      // Track parent window movement — resync the active tab's wv2 bounds
      const resyncBounds = () => {
        const activeWv2 = this.wv2Sessions.get(sessionId);
        if (activeWv2 && !activeWv2.closed) {
          const rel = activeWv2.relativeBounds;
          activeWv2.setBounds(rel, this.dipToScreen(rel));
        }
      };
      mainWindow.on('move', resyncBounds);
      mainWindow.on('resize', resyncBounds);

      this.wv2ResyncHandlers.set(sessionId, resyncBounds);

      try {
        await wv2.create(hwnd, session.originalUrl, dipBounds, this.dipToScreen(dipBounds));
        session.state = 'connected';
      } catch (err) {
        // Remove from maps on failure
        this.wv2Sessions.delete(sessionId);
        this.wv2TabMap.delete(virtualTabId);
        mainWindow.removeListener('move', resyncBounds);
        mainWindow.removeListener('resize', resyncBounds);
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[WebMgr] WebView2 creation failed: ${message}`);
        session.state = 'error';
        throw err;
      }
      return;
    }

    // ── Chromium engine (existing WebContentsView path) ──
    const activeTab = session.getActiveTab();

    if (activeTab?.view) {
      // Webview already exists (e.g. tab switch remount) — show it and update bounds
      this.showSession(sessionId);
      this.updateBounds(sessionId, x, y, width, height);
      return;
    }

    // Create the first tab if none exist
    if (session.tabs.length === 0) {
      const tabId = randomUUID();
      const tab = new WebTab(tabId, session.originalUrl);
      session.addTab(tab, true);
    }

    const tab = session.getActiveTab()!;
    this.initTabView(session, tab, x, y, width, height);
    session.state = 'connected';
  }

  /** Close and destroy a session (all tabs). */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Cancel any pending downloads for this session
    this.cancelDownloadsForSession(sessionId);

    // Clean up webContentsIdMap for all Chromium tabs
    for (const tab of session.tabs) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        this.webContentsIdMap.delete(tab.view.webContents.id);
      }
    }

    // WebView2 cleanup — close ALL tab helper processes for this session
    if (this.wv2Sessions.has(sessionId)) {
      this.wv2Sessions.delete(sessionId);
      // Remove move/resize listener
      const mainWindow = this.getMainWindow();
      const resyncFn = this.wv2ResyncHandlers.get(sessionId);
      if (mainWindow && resyncFn) {
        mainWindow.removeListener('move', resyncFn);
        mainWindow.removeListener('resize', resyncFn);
      }
      this.wv2ResyncHandlers.delete(sessionId);
      for (const tab of session.tabs) {
        const tabWv2 = this.wv2TabMap.get(tab.id);
        if (tabWv2) {
          this.wv2TabMap.delete(tab.id);
          // Hide the native HWND before closing — ensures the popup window
          // is not visible (and not capturing mouse events) while the helper
          // process shuts down. Without this, the HWND can block input on
          // the Electron window until the process fully exits.
          tabWv2.hide();
          tabWv2.close().catch((err) => {
            console.warn(`[WebMgr] WebView2 close error for tab ${tab.id.slice(0, 8)}:`, err);
          });
        }
      }
      this.sessions.delete(sessionId);
      return;
    }

    const mainWindow = this.getMainWindow();
    for (const tab of session.tabs) {
      if (tab.view) {
        if (mainWindow) {
          mainWindow.contentView.removeChildView(tab.view);
        }
        if (!tab.view.webContents.isDestroyed()) {
          tab.view.webContents.close();
        }
      }
    }

    this.sessions.delete(sessionId);
  }

  /** Hide a session's active tab webview by removing it from the parent. */
  hideSession(sessionId: string): void {
    // WebView2: hide via pipe
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.hide(); return; }

    const session = this.sessions.get(sessionId);
    const tab = session?.getActiveTab();
    if (!tab?.view) return;

    const mainWindow = this.getMainWindow();
    if (mainWindow) {
      mainWindow.contentView.removeChildView(tab.view);
    }
  }

  /** Hide ALL active session views at once (used during tab drag). */
  hideAllSessions(): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    for (const [sessionId, session] of this.sessions) {
      // WebView2
      const wv2 = this.wv2Sessions.get(sessionId);
      if (wv2) { wv2.hide(); continue; }

      // Chromium WebContentsView
      const tab = session.getActiveTab();
      if (tab?.view) {
        mainWindow.contentView.removeChildView(tab.view);
      }
    }
  }

  /** Capture a screenshot of the active tab (without hiding). Returns a JPEG data URL.
   *  Used for screenshot-freeze: the renderer loads this behind the native view,
   *  then hides the native view only after the image is ready. */
  async capturePage(sessionId: string): Promise<string> {
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) {
      const base64 = await wv2.captureScreenshot();
      return `data:image/png;base64,${base64}`;
    }

    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (!tab?.view) {
      throw new Error(`No webview for session ${sessionId}`);
    }

    const image = await tab.view.webContents.capturePage();
    if (image.isEmpty()) {
      throw new Error(`capturePage returned empty image for session ${sessionId}`);
    }
    return `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`;
  }

  /** Capture a screenshot of the active tab, then hide it. Returns a data URL. */
  async captureAndHide(sessionId: string): Promise<string> {
    // WebView2: capture then hide
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) {
      const base64 = await wv2.captureScreenshot();
      wv2.hide();
      return `data:image/png;base64,${base64}`;
    }

    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (!tab?.view) {
      throw new Error(`No webview for session ${sessionId}`);
    }

    const image = await tab.view.webContents.capturePage();
    const mainWindow = this.getMainWindow();
    if (mainWindow) {
      mainWindow.contentView.removeChildView(tab.view);
    }

    // Still hide even if empty — but return empty string so frontend knows
    // there's no usable screenshot
    if (image.isEmpty()) {
      return '';
    }

    return `data:image/png;base64,${image.toPNG().toString('base64')}`;
  }

  /** Show a session's active tab webview by re-adding it to the parent. */
  showSession(sessionId: string): void {
    // WebView2: show via pipe
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.show(); return; }

    const session = this.sessions.get(sessionId);
    const tab = session?.getActiveTab();
    if (!tab?.view) return;

    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    const b = tab.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    console.debug(`[WebMgr] showSession ${sessionId.slice(0,8)} bounds: ${b.x},${b.y} ${b.width}x${b.height}`);
    tab.view.setBounds(b);
    mainWindow.contentView.addChildView(tab.view);
  }

  /** Update the position and size of a session's active tab webview. */
  updateBounds(
    sessionId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    // WebView2: update bounds via pipe (send screen coordinates)
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) {
      const dipBounds = this.cssToDip(x, y, width, height);
      wv2.setBounds(dipBounds, this.dipToScreen(dipBounds));
      return;
    }

    const session = this.sessions.get(sessionId);
    const tab = session?.getActiveTab();
    if (!tab?.view) return;

    // Convert CSS pixels → native DIP
    const bounds = this.cssToDip(x, y, width, height);

    // Skip if bounds haven't changed
    if (tab.bounds &&
        tab.bounds.x === bounds.x && tab.bounds.y === bounds.y &&
        tab.bounds.width === bounds.width && tab.bounds.height === bounds.height) {
      return;
    }

    // console.debug(`[WebMgr] updateBounds ${sessionId.slice(0,8)}: css(${Math.round(x)},${Math.round(y)} ${Math.round(width)}x${Math.round(height)}) → dip(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height})`);
    tab.view.setBounds(bounds);
    tab.bounds = bounds;
  }

  /** Accept certificate errors for the active tab and reload the page. */
  acceptCert(sessionId: string): void {
    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (!tab) return;

    tab.certAccepted = true;
    tab.certErrorNotified = false;
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.loadURL(tab.url);
    }
  }

  /** Navigate the active tab to a new URL. */
  navigate(sessionId: string, url: string): void {
    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    // WebView2: navigate via pipe
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.navigate(url); return; }

    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (!tab?.view) {
      throw new Error(`No webview for session ${sessionId}`);
    }

    tab.view.webContents.loadURL(url);
    tab.url = url;
  }

  // ──────────────────────────────────────────────────────────────
  //  Tab management
  // ──────────────────────────────────────────────────────────────

  /** Create a new sub-tab within a session. Returns the new tab ID. */
  createTab(sessionId: string, url?: string): string {
    const session = this.getSession(sessionId);

    // WebView2: each tab gets its own helper process
    if (this.wv2Sessions.has(sessionId)) {
      if (session.tabs.length >= MAX_TABS_PER_SESSION) {
        if (url) this.navigate(sessionId, url);
        return session.getActiveTab()?.id ?? '';
      }

      const mainWindow = this.getMainWindow();
      if (!mainWindow) return session.getActiveTab()?.id ?? '';

      const tabId = randomUUID();
      const tabUrl = url ?? session.originalUrl;
      const tab = new WebTab(tabId, tabUrl);

      // Hide old active tab's wv2 popup
      const oldTab = session.getActiveTab();
      const oldWv2 = oldTab ? this.wv2TabMap.get(oldTab.id) : undefined;
      if (oldWv2) oldWv2.hide();

      session.addTab(tab, true);

      // Spawn new WebView2 process for this tab (async, fire-and-forget)
      this.spawnWv2ForTab(sessionId, tab, mainWindow).catch((err) => {
        console.error(`[WebMgr] Failed to create WebView2 tab ${tabId.slice(0, 8)}:`, err);
      });

      this.emitTabListChanged(session);
      return tabId;
    }

    if (session.tabs.length >= MAX_TABS_PER_SESSION) {
      // At limit — navigate active tab instead
      const activeTab = session.getActiveTab();
      if (activeTab?.view && url) {
        activeTab.view.webContents.loadURL(url);
        activeTab.url = url;
      }
      return activeTab?.id ?? '';
    }

    const tabId = randomUUID();
    const tabUrl = url ?? 'about:blank';
    const tab = new WebTab(tabId, tabUrl);

    // Get bounds from the currently active tab for the new tab
    const activeTab = session.getActiveTab();
    const currentBounds = activeTab?.bounds;

    // Detach the current active tab's view
    if (activeTab?.view) {
      const mainWindow = this.getMainWindow();
      if (mainWindow) {
        mainWindow.contentView.removeChildView(activeTab.view);
      }
    }

    session.addTab(tab, true);

    // Initialize the new tab's view if we have bounds
    if (currentBounds) {
      this.initTabViewWithDipBounds(session, tab, currentBounds);
    }

    // Notify frontend about the updated tab list
    this.emitTabListChanged(session);

    return tabId;
  }

  /** Close a sub-tab. Returns { lastTab: true } if it was the last tab. */
  closeTab(sessionId: string, tabId: string): { lastTab: boolean } {
    const session = this.getSession(sessionId);
    const tab = session.getTab(tabId);
    if (!tab) return { lastTab: false };

    const wasActive = session.activeTabId === tabId;

    // Close WebView2 helper process for this tab (if any)
    const tabWv2 = this.wv2TabMap.get(tabId);
    if (tabWv2) {
      this.wv2TabMap.delete(tabId);
      tabWv2.close().catch(() => {});
    }

    // Destroy the Chromium tab's view (if any)
    if (tab.view) {
      if (!tab.view.webContents.isDestroyed()) {
        this.webContentsIdMap.delete(tab.view.webContents.id);
      }
      const mainWindow = this.getMainWindow();
      if (mainWindow) {
        mainWindow.contentView.removeChildView(tab.view);
      }
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.close();
      }
    }

    session.removeTab(tabId);

    if (session.tabs.length === 0) {
      return { lastTab: true };
    }

    // If the closed tab was active, the session already picked a new active tab
    // We need to show the new active tab's view
    if (wasActive) {
      const newActive = session.getActiveTab();

      // WebView2: show new active tab's wv2 and update session pointer
      const newWv2 = newActive ? this.wv2TabMap.get(newActive.id) : undefined;
      if (newWv2) {
        this.wv2Sessions.set(sessionId, newWv2);
        newWv2.show();
      } else if (newActive?.view) {
        // Chromium path
        const mainWindow = this.getMainWindow();
        if (mainWindow) {
          if (newActive.bounds) {
            newActive.view.setBounds(newActive.bounds);
          }
          mainWindow.contentView.addChildView(newActive.view);
        }
      }
    }

    // Emit tab list update
    this.emitTabListChanged(session);

    return { lastTab: false };
  }

  /** Switch to a different sub-tab within a session. */
  switchTab(sessionId: string, tabId: string): void {
    const session = this.getSession(sessionId);
    const newTab = session.getTab(tabId);
    if (!newTab || session.activeTabId === tabId) return;

    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    const currentTab = session.getActiveTab();

    // WebView2: hide old tab's popup, show new tab's popup
    if (this.wv2Sessions.has(sessionId)) {
      const oldWv2 = currentTab ? this.wv2TabMap.get(currentTab.id) : undefined;
      const newWv2 = this.wv2TabMap.get(tabId);
      if (oldWv2) oldWv2.hide();
      session.activeTabId = tabId;
      if (newWv2) {
        this.wv2Sessions.set(sessionId, newWv2);
        newWv2.show();
      }
      this.emitNavState(session.id, newTab);
      this.emitTabListChanged(session);
      return;
    }

    // Chromium: detach current view, attach new view
    if (currentTab?.view) {
      mainWindow.contentView.removeChildView(currentTab.view);
    }

    session.activeTabId = tabId;

    if (newTab.view) {
      if (!newTab.bounds && currentTab?.bounds) {
        newTab.bounds = { ...currentTab.bounds };
      }
      if (newTab.bounds) {
        newTab.view.setBounds(newTab.bounds);
      }
      mainWindow.contentView.addChildView(newTab.view);
    }

    this.emitNavState(session.id, newTab);
    this.emitTabListChanged(session);
  }

  /** Go back in the active tab's history. */
  goBack(sessionId: string): void {
    // WebView2: native go_back via pipe protocol
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.goBack(); return; }

    const tab = this.getActiveTabOrThrow(sessionId);
    if (tab.view && tab.canGoBack) {
      tab.view.webContents.goBack();
    }
  }

  /** Go forward in the active tab's history. */
  goForward(sessionId: string): void {
    // WebView2: native go_forward via pipe protocol
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.goForward(); return; }

    const tab = this.getActiveTabOrThrow(sessionId);
    if (tab.view && tab.canGoForward) {
      tab.view.webContents.goForward();
    }
  }

  /** Reorder a tab within a session. */
  reorderTab(sessionId: string, fromIndex: number, toIndex: number): void {
    const session = this.getSession(sessionId);
    session.reorderTab(fromIndex, toIndex);
    this.emitTabListChanged(session);
  }

  /** Reload the active tab. */
  reload(sessionId: string): void {
    // WebView2: reload via navigate
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.executeScript('location.reload()').catch(() => {}); return; }

    const tab = this.getActiveTabOrThrow(sessionId);
    if (tab.view) {
      tab.view.webContents.reload();
    }
  }

  /** Stop loading the active tab. */
  stopLoading(sessionId: string): void {
    // WebView2: stop via JS
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) { wv2.executeScript('window.stop()').catch(() => {}); return; }

    const tab = this.getActiveTabOrThrow(sessionId);
    if (tab.view) {
      tab.view.webContents.stop();
    }
  }

  /** Get the list of tabs for a session. */
  getTabList(sessionId: string): { tabs: WebTabInfo[]; activeTabId: string | null } {
    const session = this.getSession(sessionId);
    return {
      tabs: session.tabs.map((t) => t.toInfo()),
      activeTabId: session.activeTabId,
    };
  }

  /** Get the original URL for a session (for the Home button). */
  getOriginalUrl(sessionId: string): string {
    return this.getSession(sessionId).originalUrl;
  }

  // ──────────────────────────────────────────────────────────────
  //  Read methods (delegate to active tab)
  // ──────────────────────────────────────────────────────────────

  /** Take a screenshot of the active tab. Returns base64-encoded image + dimensions. */
  async screenshot(
    sessionId: string,
    format: 'png' | 'jpeg' = 'png',
    quality = 85,
    maxWidth?: number,
  ): Promise<{ image: string; imageWidth: number; imageHeight: number }> {
    // WebView2: capture via pipe
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) {
      const base64 = await wv2.captureScreenshot();
      let img = sharp(Buffer.from(base64, 'base64'));
      if (maxWidth && maxWidth > 0) {
        img = img.resize({ width: maxWidth, withoutEnlargement: true });
      }
      let outputBuffer: Buffer;
      if (format === 'jpeg') {
        outputBuffer = await img.jpeg({ quality }).toBuffer();
      } else {
        outputBuffer = await img.png().toBuffer();
      }
      const metadata = await sharp(outputBuffer).metadata();
      return {
        image: outputBuffer.toString('base64'),
        imageWidth: metadata.width ?? 0,
        imageHeight: metadata.height ?? 0,
      };
    }

    const tab = this.getActiveTabOrThrow(sessionId);
    if (!tab.view) throw new Error(`No webview for session ${sessionId}`);

    const nativeImage = await tab.view.webContents.capturePage();
    const pngBuffer = nativeImage.toPNG();

    let img = sharp(pngBuffer);

    if (maxWidth && maxWidth > 0) {
      img = img.resize({ width: maxWidth, withoutEnlargement: true });
    }

    let outputBuffer: Buffer;
    if (format === 'jpeg') {
      outputBuffer = await img.jpeg({ quality }).toBuffer();
    } else {
      outputBuffer = await img.png().toBuffer();
    }

    const metadata = await sharp(outputBuffer).metadata();

    return {
      image: outputBuffer.toString('base64'),
      imageWidth: metadata.width ?? 0,
      imageHeight: metadata.height ?? 0,
    };
  }

  /** Read content from the active tab by executing JavaScript. */
  async readContent(sessionId: string, selector?: string, format?: string): Promise<string> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.getActiveTabOrThrow(sessionId);
    return interaction.webReadContent(wv2, tab?.view ?? undefined, selector, format);
  }

  /** Get the current URL of the active tab. */
  getUrl(sessionId: string): string {
    // WebView2: URL tracked via navigation events
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) return wv2.currentUrl;

    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (tab?.view && !tab.view.webContents.isDestroyed()) {
      return tab.view.webContents.getURL();
    }
    return session.url;
  }

  /** Get the current title of the active tab. */
  getTitle(sessionId: string): string | null {
    // WebView2: title tracked via title events
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) return wv2.currentTitle;

    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (tab?.view && !tab.view.webContents.isDestroyed()) {
      return tab.view.webContents.getTitle() || tab.title;
    }
    return session.title;
  }

  /** List all sessions. */
  listSessions(): WebSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.toInfo());
  }

  /** Hide all session views (remove from parent without destroying).
   *  Used to clean up orphaned views after renderer reloads. */
  hideAll(): void {
    // Hide all WebView2 tab sessions (not just active ones)
    for (const wv2 of this.wv2TabMap.values()) {
      wv2.hide();
    }

    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;
    for (const session of this.sessions.values()) {
      for (const tab of session.tabs) {
        if (tab.view) {
          mainWindow.contentView.removeChildView(tab.view);
        }
      }
    }
  }

  /** Destroy all sessions (cleanup on app quit). */
  destroyAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
  }

  // ──────────────────────────────────────────────────────────────
  //  Autofill (delegates to web-autofill-handler.ts)
  // ──────────────────────────────────────────────────────────────

  async discoverFields(sessionId: string): Promise<DiscoveryResult> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.getActiveTabOrThrow(sessionId);
    return autofill.discoverFields(wv2, tab, sessionId);
  }

  async fillFields(sessionId: string, username: string | null, password: string | null, userSelector: string | null, pwSelector: string | null): Promise<FillResult> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.getActiveTabOrThrow(sessionId);
    return autofill.fillFields(wv2, tab, sessionId, username, password, userSelector, pwSelector);
  }

  async clickElement(sessionId: string, selector: string): Promise<boolean> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.getActiveTabOrThrow(sessionId);
    return autofill.clickElement(wv2, tab, sessionId, selector);
  }

  async executeAutofill(
    sessionId: string, username: string | null, password: string | null,
    config: { usernameSelector?: string; passwordSelector?: string; submitSelector?: string; multiStepLogin?: boolean },
  ): Promise<{ success: boolean; phase: string; fieldsFilled: string[]; error?: string }> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.getActiveTabOrThrow(sessionId);
    return autofill.executeAutofill(wv2, tab, sessionId, username, password, config);
  }

  async startSelectorPicker(sessionId: string): Promise<PickerResult | null> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.getSession(sessionId).getActiveTab() ?? undefined;
    return autofill.startSelectorPicker(wv2, tab, sessionId, () => this.cancelSelectorPicker(sessionId));
  }

  async cancelSelectorPicker(sessionId: string): Promise<void> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const tab = wv2 ? undefined : this.sessions.get(sessionId)?.getActiveTab() ?? undefined;
    return autofill.cancelSelectorPicker(wv2, tab);
  }

  // ──────────────────────────────────────────────────────────────
  //  Interaction methods (for MCP tools)
  // ──────────────────────────────────────────────────────────────

  click(sessionId: string, x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', doubleClick = false): void {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    interaction.webClick(wv2, view, x, y, button, doubleClick);
  }

  async typeText(sessionId: string, text: string): Promise<void> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    return interaction.webTypeText(wv2, view, text);
  }

  sendKey(sessionId: string, key: string, modifiers: string[] = [], action: 'press' | 'down' | 'up' = 'press'): void {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    interaction.webSendKey(wv2, view, key, modifiers, action);
  }

  mouseMove(sessionId: string, x: number, y: number): void {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    interaction.webMouseMove(wv2, view, x, y);
  }

  mouseDrag(sessionId: string, fromX: number, fromY: number, toX: number, toY: number, button: 'left' | 'right' | 'middle' = 'left'): void {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    interaction.webMouseDrag(wv2, view, fromX, fromY, toX, toY, button);
  }

  mouseScroll(sessionId: string, x: number, y: number, deltaX: number, deltaY: number): void {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    interaction.webMouseScroll(wv2, view, x, y, deltaX, deltaY);
  }

  getViewportDimensions(sessionId: string): { width: number; height: number } {
    const wv2 = this.wv2Sessions.get(sessionId);
    if (wv2) return wv2.lastBounds;
    const tab = this.getActiveTabOrThrow(sessionId);
    if (!tab.view) throw new Error(`No webview for session ${sessionId}`);
    const bounds = tab.view.getBounds();
    return { width: bounds.width, height: bounds.height };
  }

  async fillInput(sessionId: string, selector: string, value: string): Promise<boolean> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    return interaction.webFillInput(wv2, view, selector, value);
  }

  async getInteractiveElements(sessionId: string): Promise<unknown> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    return interaction.webGetInteractiveElements(wv2, view);
  }

  async executeJs(sessionId: string, code: string): Promise<unknown> {
    const wv2 = this.wv2Sessions.get(sessionId);
    const view = wv2 ? undefined : this.getActiveTabOrThrow(sessionId).view ?? undefined;
    return interaction.webExecuteJs(wv2, view, code);
  }

  // ──────────────────────────────────────────────────────────────
  //  Private helpers
  // ──────────────────────────────────────────────────────────────

  private getSession(sessionId: string): WebSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  private getActiveTabOrThrow(sessionId: string): WebTab {
    const session = this.getSession(sessionId);
    const tab = session.getActiveTab();
    if (!tab) {
      throw new Error(`No active tab for session ${sessionId}`);
    }
    return tab;
  }

  /** Initialize a tab's WebContentsView and add it to the main window. */
  private initTabView(
    session: WebSession,
    tab: WebTab,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) throw new Error('Main window not available');

    const view = new WebContentsView();

    // Set user agent if specified
    if (session.userAgent) {
      view.webContents.setUserAgent(session.userAgent);
    }

    this.setupTabEventHandlers(session, tab, view);

    // Register for download event matching
    this.ensureDownloadHandler();
    this.webContentsIdMap.set(view.webContents.id, { sessionId: session.id, tabId: tab.id });

    // Convert CSS pixels from renderer to native DIP coordinates
    const bounds = this.cssToDip(x, y, width, height);
    view.setBounds(bounds);
    mainWindow.contentView.addChildView(view);

    // Load the URL
    view.webContents.loadURL(tab.url);

    tab.view = view;
    tab.bounds = bounds;
  }

  /** Initialize a tab's WebContentsView using DIP bounds directly. */
  private initTabViewWithDipBounds(
    session: WebSession,
    tab: WebTab,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) throw new Error('Main window not available');

    const view = new WebContentsView();

    if (session.userAgent) {
      view.webContents.setUserAgent(session.userAgent);
    }

    this.setupTabEventHandlers(session, tab, view);

    // Register for download event matching
    this.ensureDownloadHandler();
    this.webContentsIdMap.set(view.webContents.id, { sessionId: session.id, tabId: tab.id });

    view.setBounds(bounds);
    mainWindow.contentView.addChildView(view);

    view.webContents.loadURL(tab.url);

    tab.view = view;
    tab.bounds = { ...bounds };
  }

  /** Wire up events for a WebView2 tab's session (navigation, title, close). */
  private wireWv2TabEvents(
    sessionId: string,
    tab: WebTab,
    wv2: WebView2Session,
    mainWindow: BrowserWindow,
  ): void {
    const tabId = tab.id;

    wv2.on('navigation-completed', (data: { url: string; success: boolean; canGoBack: boolean; canGoForward: boolean }) => {
      const session = this.sessions.get(sessionId);
      if (session) session.state = data.success ? 'connected' : 'error';
      tab.url = data.url;
      tab.canGoBack = data.canGoBack;
      tab.canGoForward = data.canGoForward;
      mainWindow.webContents.send('web:nav-state-changed', {
        sessionId,
        tabId,
        url: data.url,
        isLoading: false,
        canGoBack: data.canGoBack,
        canGoForward: data.canGoForward,
      });
    });

    wv2.on('title-changed', (data: { title: string }) => {
      tab.title = data.title;
      mainWindow.webContents.send('web:tab-title-changed', {
        sessionId,
        tabId,
        title: data.title,
      });
    });

    wv2.on('new-window', (url: string) => {
      // Open link-clicks that request a new window as a new tab in this session
      const newTabId = this.createTab(sessionId, url);
      const session = this.sessions.get(sessionId);
      if (session) {
        mainWindow.webContents.send('web:tab-created', { sessionId, tabId: newTabId, url });
        this.emitTabListChanged(session);
      }
    });

    wv2.on('closed', () => {
      this.wv2TabMap.delete(tabId);
      // If this was the active session pointer, remove it
      if (this.wv2Sessions.get(sessionId) === wv2) {
        this.wv2Sessions.delete(sessionId);
      }
      const session = this.sessions.get(sessionId);
      if (session) session.state = 'disconnected';
    });

    // ── Download events ──
    wv2.on('download-starting', (data: { downloadId: string; url: string; filename: string; totalBytes: number; mimeType: string }) => {
      const filename = path.basename(data.filename) || 'download';

      this.pendingDownloads.set(data.downloadId, {
        downloadId: data.downloadId,
        sessionId,
        tabId,
        filename,
        totalBytes: data.totalBytes,
        mimeType: data.mimeType,
        url: data.url,
        engine: 'webview2',
        wv2SessionRef: wv2,
      });

      mainWindow.webContents.send('web:download-prompt', {
        downloadId: data.downloadId,
        sessionId,
        tabId,
        filename,
        totalBytes: data.totalBytes,
        mimeType: data.mimeType,
        url: data.url,
      });
    });

    wv2.on('download-progress', (data: { downloadId: string; receivedBytes: number; totalBytes: number }) => {
      mainWindow.webContents.send('web:download-progress', data);
    });

    wv2.on('download-done', (data: { downloadId: string; state: string; savePath: string }) => {
      const dl = this.pendingDownloads.get(data.downloadId);
      mainWindow.webContents.send('web:download-done', {
        ...data,
        action: dl?.action,
      });
      this.pendingDownloads.delete(data.downloadId);
    });
  }

  /** Spawn a new WebView2 helper process for an additional tab. */
  private async spawnWv2ForTab(
    sessionId: string,
    tab: WebTab,
    mainWindow: BrowserWindow,
  ): Promise<void> {
    const hwnd = mainWindow.getNativeWindowHandle();

    const wv2 = new WebView2Session(tab.id);
    this.wv2TabMap.set(tab.id, wv2);
    this.wireWv2TabEvents(sessionId, tab, wv2, mainWindow);

    try {
      // Don't pass initial bounds — the popup starts hidden at 1×1.
      // The frontend will call updateBounds after the tab bar renders,
      // which positions and shows the popup at the correct offset.
      await wv2.create(hwnd, tab.url);

      // Only promote to active session pointer after successful create
      this.wv2Sessions.set(sessionId, wv2);

      // Re-emit tab list now that the pipe is connected. The first
      // emitTabListChanged (in createTab) fires before the pipe is ready,
      // so the frontend's syncBounds message gets silently dropped.
      // This second emit triggers syncBounds again with a live pipe.
      const session = this.sessions.get(sessionId);
      if (session) this.emitTabListChanged(session);
    } catch (err) {
      // Cleanup on failure — don't leave stale entries in the maps
      this.wv2TabMap.delete(tab.id);
      const session = this.sessions.get(sessionId);
      if (session) session.removeTab(tab.id);
      throw err;
    }
  }

  /** Set up all event handlers for a tab's WebContentsView. */
  private setupTabEventHandlers(session: WebSession, tab: WebTab, view: WebContentsView): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    const sessionId = session.id;
    const tabId = tab.id;

    // ── Certificate errors ──
    view.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
      event.preventDefault();
      if (session.ignoreCertErrors || tab.certAccepted) {
        callback(true);
        return;
      }
      if (tab.certErrorNotified) {
        callback(false);
        return;
      }
      tab.certErrorNotified = true;

      console.warn(`[web] cert error for session ${sessionId}: ${error} (${url})`);
      callback(false);
      mainWindow.webContents.send('web:cert-error', {
        sessionId,
        tabId,
        url,
        error,
        issuer: certificate.issuerName,
        subject: certificate.subjectName,
      });
    });

    // ── Load failures ──
    view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      console.warn(`[WebMgr] Load failed for session ${sessionId}: ${errorDescription} (code ${errorCode}, url: ${validatedURL})`);
      session.state = 'error';
      mainWindow.webContents.send('web:status', {
        sessionId,
        status: 'disconnected',
        error: errorDescription || `Page load failed (error ${errorCode})`,
      });
    });

    // ── Navigation state tracking ──
    view.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      tab.isLoading = true;
      tab.url = url;
      this.emitNavState(sessionId, tab);
    });

    view.webContents.on('did-navigate', (_event, url) => {
      tab.url = url;
      tab.isLoading = false;
      tab.canGoBack = view.webContents.canGoBack();
      tab.canGoForward = view.webContents.canGoForward();
      tab.certErrorNotified = false;
      this.emitNavState(sessionId, tab);
    });

    view.webContents.on('did-navigate-in-page', (_event, url) => {
      tab.url = url;
      tab.canGoBack = view.webContents.canGoBack();
      tab.canGoForward = view.webContents.canGoForward();
      this.emitNavState(sessionId, tab);
    });

    view.webContents.on('did-stop-loading', () => {
      tab.isLoading = false;
      tab.canGoBack = view.webContents.canGoBack();
      tab.canGoForward = view.webContents.canGoForward();
      this.emitNavState(sessionId, tab);
    });

    // ── Title changes ──
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title;
      mainWindow.webContents.send('web:tab-title-changed', {
        sessionId,
        tabId,
        title,
      });
    });

    // ── Favicon changes ──
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons[0] ?? null;
      mainWindow.webContents.send('web:tab-favicon-changed', {
        sessionId,
        tabId,
        favicon: tab.favicon,
      });
    });

    // ── Auto-autofill on first page load ──
    view.webContents.on('did-finish-load', () => {
      if (session.entryId && !tab.autoAutofilled && this.onPageLoaded) {
        tab.autoAutofilled = true;
        this.onPageLoaded(sessionId, session.entryId);
      }
    });

    // ── Handle window.open / target="_blank" → new sub-tab ──
    view.webContents.setWindowOpenHandler(({ url, disposition }) => {
      if (['foreground-tab', 'background-tab', 'new-window'].includes(disposition)) {
        const newTabId = this.createTab(sessionId, url);
        mainWindow.webContents.send('web:tab-created', {
          sessionId,
          tabId: newTabId,
          url,
        });
        this.emitTabListChanged(session);
      }
      return { action: 'deny' };
    });
  }

  /** Emit navigation state update for a tab. */
  private emitNavState(sessionId: string, tab: WebTab): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    mainWindow.webContents.send('web:nav-state-changed', {
      sessionId,
      tabId: tab.id,
      url: tab.url,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    });
  }

  /** Emit the full tab list for a session (after tab create/close). */
  private emitTabListChanged(session: WebSession): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    mainWindow.webContents.send('web:tab-list-changed', {
      sessionId: session.id,
      tabs: session.tabs.map((t) => t.toInfo()),
      activeTabId: session.activeTabId,
    });
  }

  // ──────────────────────────────────────────────────────────────
  //  Download handling
  // ──────────────────────────────────────────────────────────────

  /** Register the global will-download handler on Electron's default session (once). */
  private ensureDownloadHandler(): void {
    if (this.downloadHandlerRegistered) return;
    this.downloadHandlerRegistered = true;

    electronSession.defaultSession.on('will-download', (_event, item, webContents) => {
      const tabInfo = this.webContentsIdMap.get(webContents.id);
      if (!tabInfo) return; // Not from one of our managed web session tabs

      // Deduplicate: if there's already a pending download for this tab with the
      // same URL (e.g. from an HTTP redirect creating a second will-download),
      // cancel the old one silently and use the new DownloadItem.
      const itemUrl = item.getURL();
      for (const [existingId, dl] of this.pendingDownloads) {
        if (dl.sessionId === tabInfo.sessionId && dl.tabId === tabInfo.tabId && dl.url === itemUrl) {
          if (dl.electronItem) dl.electronItem.cancel();
          this.pendingDownloads.delete(existingId);
          break;
        }
      }

      this.handleChromiumDownload(item, tabInfo.sessionId, tabInfo.tabId);
    });
  }

  /** Handle a Chromium download: pause it and prompt the user via toast. */
  private handleChromiumDownload(
    item: Electron.DownloadItem,
    sessionId: string,
    tabId: string,
  ): void {
    const downloadId = randomUUID();
    const filename = item.getFilename();
    const totalBytes = item.getTotalBytes();
    const mimeType = item.getMimeType();
    const url = item.getURL();

    // Set save path to temp to prevent Electron's native save dialog
    const tempPath = path.join(app.getPath('temp'), `conduit-dl-${downloadId}-${filename}`);
    item.setSavePath(tempPath);

    // Pause immediately — download won't progress until user decides
    item.pause();

    const pending: PendingDownload = {
      downloadId, sessionId, tabId, filename, totalBytes, mimeType, url,
      engine: 'chromium',
      electronItem: item,
    };
    this.pendingDownloads.set(downloadId, pending);

    // Prompt the renderer
    const mainWindow = this.getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send('web:download-prompt', {
        downloadId, sessionId, tabId, filename, totalBytes, mimeType, url,
      });
    }

    // Wire progress updates (fire when resumed)
    item.on('updated', (_event, state) => {
      if (state === 'progressing' && mainWindow) {
        mainWindow.webContents.send('web:download-progress', {
          downloadId,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
        });
      }
    });

    // Wire completion
    item.on('done', (_event, state) => {
      const dl = this.pendingDownloads.get(downloadId);

      // If download completed before the user chose an action (small files),
      // stash the completed path and wait — don't send the done event yet.
      if (state === 'completed' && dl && !dl.action) {
        dl.completedPath = tempPath;
        return;
      }

      this.pendingDownloads.delete(downloadId);

      if (state === 'completed' && dl?.action === 'open') {
        // Open action: open with default app, then notify frontend
        shell.openPath(tempPath).then((errMsg) => {
          if (errMsg) console.error(`[WebMgr] Failed to open file: ${errMsg}`);
        });
        mainWindow?.webContents.send('web:download-done', {
          downloadId, state: 'completed', savePath: tempPath, action: 'open',
        });
      } else if (state === 'completed' && dl?.userSavePath) {
        // Save As action: move from temp to user-chosen path
        try {
          fs.renameSync(tempPath, dl.userSavePath);
        } catch {
          try {
            fs.copyFileSync(tempPath, dl.userSavePath);
            fs.unlinkSync(tempPath);
          } catch (moveErr) {
            console.error(`[WebMgr] Failed to move download to ${dl.userSavePath}:`, moveErr);
          }
        }
        mainWindow?.webContents.send('web:download-done', {
          downloadId, state: 'completed', savePath: dl.userSavePath, action: 'save',
        });
      } else {
        if (state !== 'completed') {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
        mainWindow?.webContents.send('web:download-done', {
          downloadId, state, action: dl?.action,
        });
      }
    });
  }

  /** Get a pending download's info (used by IPC handlers). */
  getPendingDownload(downloadId: string): PendingDownload | undefined {
    return this.pendingDownloads.get(downloadId);
  }

  /** Cancel a pending or active download. */
  cancelDownload(downloadId: string): void {
    const pending = this.pendingDownloads.get(downloadId);
    if (!pending) return;

    // Clean up temp file if download already completed
    if (pending.completedPath) {
      try { fs.unlinkSync(pending.completedPath); } catch { /* ignore */ }
    } else if (pending.engine === 'chromium' && pending.electronItem) {
      pending.electronItem.cancel();
    } else if (pending.engine === 'webview2' && pending.wv2SessionRef) {
      pending.wv2SessionRef.respondToDownload(downloadId, 'cancel');
    }

    this.pendingDownloads.delete(downloadId);
  }

  /** Resume a paused download for the "Open" action (temp path already set). */
  resumeDownloadForOpen(downloadId: string): void {
    const pending = this.pendingDownloads.get(downloadId);
    if (!pending) return;

    pending.action = 'open';
    const mainWindow = this.getMainWindow();

    // If the file already completed (small file), open it immediately
    if (pending.completedPath) {
      this.pendingDownloads.delete(downloadId);
      shell.openPath(pending.completedPath).then((errMsg) => {
        if (errMsg) console.error(`[WebMgr] Failed to open file: ${errMsg}`);
      });
      mainWindow?.webContents.send('web:download-done', {
        downloadId, state: 'completed', savePath: pending.completedPath, action: 'open',
      });
      return;
    }

    if (pending.engine === 'chromium' && pending.electronItem) {
      pending.electronItem.resume();
    } else if (pending.engine === 'webview2' && pending.wv2SessionRef) {
      const tempPath = path.join(app.getPath('temp'), `conduit-dl-${downloadId}-${pending.filename}`);
      pending.wv2SessionRef.respondToDownload(downloadId, 'open', tempPath);
    }
  }

  /** Resume a download for the "Save As" action. For Chromium, file is moved from temp on completion. */
  resumeDownloadForSave(downloadId: string, savePath: string): void {
    const pending = this.pendingDownloads.get(downloadId);
    if (!pending) return;

    pending.action = 'save';
    pending.userSavePath = savePath;
    const mainWindow = this.getMainWindow();

    // If the file already completed (small file), move it immediately
    if (pending.completedPath) {
      this.pendingDownloads.delete(downloadId);
      try {
        fs.renameSync(pending.completedPath, savePath);
      } catch {
        try {
          fs.copyFileSync(pending.completedPath, savePath);
          fs.unlinkSync(pending.completedPath);
        } catch (moveErr) {
          console.error(`[WebMgr] Failed to move download to ${savePath}:`, moveErr);
        }
      }
      mainWindow?.webContents.send('web:download-done', {
        downloadId, state: 'completed', savePath, action: 'save',
      });
      return;
    }

    if (pending.engine === 'chromium' && pending.electronItem) {
      pending.electronItem.resume();
    } else if (pending.engine === 'webview2' && pending.wv2SessionRef) {
      pending.wv2SessionRef.respondToDownload(downloadId, 'save', savePath);
    }
  }

  /** Cancel all pending downloads for a session (called on session close). */
  private cancelDownloadsForSession(sessionId: string): void {
    for (const [id, dl] of this.pendingDownloads) {
      if (dl.sessionId === sessionId) {
        if (dl.engine === 'chromium' && dl.electronItem) {
          dl.electronItem.cancel();
        }
        this.pendingDownloads.delete(id);
      }
    }
  }
}
