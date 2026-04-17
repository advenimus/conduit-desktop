import { app, BaseWindow, BrowserWindow, globalShortcut, KeyboardEvent as ElectronKeyboardEvent, Menu, MenuItem, Tray, nativeImage, nativeTheme, ipcMain, shell, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fixPath from 'fix-path';
import { registerIpcHandlers } from './ipc/index.js';
import { setupAutoUpdater, stopPeriodicUpdateChecks, downloadedVersion } from './ipc/updater.js';
import { OverlayManager } from './services/overlay/overlay-manager.js';
import { logger } from './services/logger.js';
import { AppState } from './services/state.js';
import { writeAgentInstructions } from './services/agent-instructions.js';
import { readAll, writeAll } from './ipc/ui-state.js';
import { readSettings } from './ipc/settings.js';
import { lockVaultFromMain } from './ipc/vault.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

// Fix process.env.PATH for packaged apps on macOS/Linux.
// Packaged Electron apps launched from Finder inherit a minimal PATH that
// doesn't include user-installed CLI locations (/opt/homebrew/bin, ~/.local/bin, etc.).
// This must run before any engine availability checks (e.g. `claude --version`).
fixPath();

// Suppress Chromium's verbose native logging (e.g. ssl_client_socket_impl.cc
// errors that fire for every sub-resource on sites with untrusted certs).
// Level 3 = FATAL only.  Our own console.log/warn output is unaffected.
app.commandLine.appendSwitch('log-level', '3');

// Prevent uncaught errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});

const isMac = process.platform === 'darwin';

// Set AppUserModelId to match electron-builder appId so Windows correctly
// associates taskbar icons, shortcuts, and notifications with this app.
// Must be called before app.whenReady() for consistent behavior.
app.setAppUserModelId('com.conduit.app');

// ── Deep link protocol registration ──────────────────────────────────
// Register 'conduit://' as a custom protocol for auth callbacks
if (isDev && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('conduit', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('conduit');
}

// Queue deep link URLs that arrive before the app is fully ready
let pendingDeepLinkUrl: string | null = null;
let pendingFilePath: string | null = null;
let appReady = false;

/** Handle incoming deep link URL (conduit://auth/callback#access_token=...) */
function handleDeepLink(url: string) {
  console.log('[main] Deep link received:', url);

  if (!appReady) {
    console.log('[main] App not ready yet, queuing deep link');
    pendingDeepLinkUrl = url;
    return;
  }

  processDeepLink(url);
}

function processDeepLink(url: string) {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) {
    console.warn('[main] Deep link has no hash fragment');
    return;
  }

  const hash = url.substring(hashIndex + 1);
  const params = new URLSearchParams(hash);

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');

  console.log('[main] Parsed deep link — has access_token:', !!accessToken, 'has refresh_token:', !!refreshToken);

  if (accessToken && refreshToken) {
    const state = AppState.getInstance();
    state.authService.handleDeepLinkTokens(accessToken, refreshToken).catch((err) => {
      console.error('[main] Failed to handle deep link tokens:', err);
    });
  }

  // Focus the main window
  const win = mainWindowRef;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

// Single instance lock — needed for Windows/Linux deep links
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // On Windows/Linux, the deep link URL is passed as a command line argument
    const url = commandLine.find(arg => arg.startsWith('conduit://'));
    if (url) handleDeepLink(url);

    // File association: check for .conduit file in command line args
    const fileArg = commandLine.find(arg => arg.endsWith('.conduit'));
    if (fileArg) handleFileOpen(fileArg);

    // Focus existing window, or recreate if it was destroyed
    const win = mainWindowRef;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });
}

// macOS: handle deep links via open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── File association handling (.conduit vault files) ─────────────────
/** Handle a .conduit file opened via Finder/Explorer */
function handleFileOpen(filePath: string) {
  if (!filePath.endsWith('.conduit')) return;
  console.log('[main] File open received:', filePath);

  if (!appReady) {
    pendingFilePath = filePath;
    return;
  }

  processFileOpen(filePath);
}

function processFileOpen(filePath: string) {
  const win = mainWindowRef;
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('open-vault-file', filePath);
  }
}

// macOS: handle file associations via open-file event
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  handleFileOpen(filePath);
});

// Keep a reference to prevent GC
import { isQuitting, setIsQuitting } from './services/app-lifecycle.js';
let tray: Tray | null = null;
let pickerWindow: BrowserWindow | null = null;
let overlayManager: OverlayManager | null = null;
let mainWindowRef: BrowserWindow | null = null;

function getTrayIcon(): Electron.NativeImage {
  const base = isDev
    ? path.join(__dirname, '../resources/icons/tray')
    : path.join(process.resourcesPath, 'icons/tray');

  if (isMac) {
    // Template images: macOS uses only the alpha channel and auto-handles dark/light.
    // Electron auto-detects trayTemplate@2x.png for Retina displays.
    const icon = nativeImage.createFromPath(path.join(base, 'trayTemplate.png'));
    icon.setTemplateImage(true);
    return icon;
  }

  // Windows/Linux: pick icon variant based on current system theme
  const file = nativeTheme.shouldUseDarkColors ? 'tray-dark.png' : 'tray-light.png';
  return nativeImage.createFromPath(path.join(base, file));
}

function createPickerWindow() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.focus();
    return;
  }

  // Position near tray icon
  let x: number | undefined;
  let y: number | undefined;
  const pickerWidth = 380;
  const pickerHeight = 500;

  if (tray) {
    const trayBounds = tray.getBounds();
    if (trayBounds.width > 0 && trayBounds.height > 0) {
      const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
      x = Math.round(trayBounds.x + trayBounds.width / 2 - pickerWidth / 2);
      if (isMac) {
        // macOS: below menu bar
        y = trayBounds.y + trayBounds.height + 4;
      } else {
        // Windows: above taskbar
        y = trayBounds.y - pickerHeight - 4;
      }
      // Clamp to screen bounds
      x = Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - pickerWidth));
      y = Math.max(display.workArea.y, Math.min(y, display.workArea.y + display.workArea.height - pickerHeight));
    }
  }

  pickerWindow = new BrowserWindow({
    width: pickerWidth,
    height: pickerHeight,
    ...(x != null && y != null ? { x, y } : { center: true }),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    pickerWindow.loadURL('http://localhost:1420/picker.html');
  } else {
    pickerWindow.loadFile(path.join(__dirname, '../dist/picker.html'));
  }

  pickerWindow.once('ready-to-show', () => {
    pickerWindow?.show();
  });

  pickerWindow.on('blur', () => {
    // Close on click outside
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
  });

  pickerWindow.on('closed', () => {
    pickerWindow = null;
  });
}

function createTray(mainWindow: BrowserWindow) {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Conduit');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Conduit',
      click: () => {
        if (mainWindow.isDestroyed()) return;
        if (mainWindow.isVisible()) {
          mainWindow.focus();
        } else {
          mainWindow.show();
        }
      },
    },
    {
      label: 'Credential Picker',
      accelerator: 'CmdOrCtrl+Shift+Space',
      click: () => createPickerWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  if (isMac) {
    // macOS: context menu on click is the standard tray behavior
    tray.setContextMenu(contextMenu);
  } else {
    // Windows/Linux: left-click shows the window, right-click shows context menu.
    // Using setContextMenu on Windows makes left-click open the menu instead of
    // showing the window, so we handle right-click manually.
    tray.on('right-click', () => {
      tray?.popUpContextMenu(contextMenu);
    });
  }

  tray.on('click', () => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Windows/Linux: swap tray icon when system theme changes
  if (!isMac) {
    nativeTheme.on('updated', () => {
      if (tray) tray.setImage(getTrayIcon());
    });
  }
}

function sendMenuAction(action: string) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('menu-action', action);
  }
}

function buildAppMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              {
                label: 'Settings',
                accelerator: 'CmdOrCtrl+,',
                click: () => sendMenuAction('settings'),
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Vault',
          click: () => sendMenuAction('new-vault'),
        },
        {
          label: 'Open Vault...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('open-vault'),
        },
        { type: 'separator' },
        {
          label: 'New Entry',
          accelerator: 'CmdOrCtrl+E',
          click: () => sendMenuAction('new-entry'),
        },
        {
          label: 'New Folder',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => sendMenuAction('new-folder'),
        },
        { type: 'separator' },
        {
          label: 'Export',
          click: () => sendMenuAction('export-vault'),
        },
        {
          label: 'Import',
          submenu: [
            {
              label: 'From Conduit Export...',
              click: () => sendMenuAction('import-export'),
            },
            { type: 'separator' },
            {
              label: 'From Remote Desktop Manager...',
              click: () => sendMenuAction('import-rdm'),
            },
          ],
        },
        { type: 'separator' },
        {
          label: 'Vault Management',
          submenu: [
            {
              label: 'Save Vault',
              accelerator: 'CmdOrCtrl+S',
              click: () => sendMenuAction('save-vault'),
            },
            { type: 'separator' },
            {
              label: 'Switch Vault...',
              click: () => sendMenuAction('switch-vault'),
            },
            {
              label: 'Lock Vault',
              accelerator: 'CmdOrCtrl+Shift+L',
              click: () => sendMenuAction('lock-vault'),
            },
            {
              label: 'Rename Vault...',
              click: () => sendMenuAction('rename-vault'),
            },
            { type: 'separator' },
            {
              label: 'Change Password...',
              click: () => sendMenuAction('change-vault-password'),
            },
          ],
        },
        { type: 'separator' },
        {
          label: 'Sign Out',
          click: () => sendMenuAction('sign-out'),
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendMenuAction('settings'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Edit menu — required on macOS for Cmd+C/V/X/A to reach the renderer
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View menu (dev only)
    ...(isDev ? [{
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: (_mi: MenuItem, win: BaseWindow | undefined, _ev: ElectronKeyboardEvent) => {
            const bw = win as BrowserWindow | undefined;
            if (bw) {
              bw.webContents.setZoomFactor(1);
              bw.webContents.send('zoom-factor-changed', 1);
            }
          },
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: (_mi: MenuItem, win: BaseWindow | undefined, _ev: ElectronKeyboardEvent) => {
            const bw = win as BrowserWindow | undefined;
            if (bw) {
              const next = Math.min(bw.webContents.getZoomFactor() + 0.05, 1.5);
              bw.webContents.setZoomFactor(next);
              bw.webContents.send('zoom-factor-changed', next);
            }
          },
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: (_mi: MenuItem, win: BaseWindow | undefined, _ev: ElectronKeyboardEvent) => {
            const bw = win as BrowserWindow | undefined;
            if (bw) {
              const next = Math.max(bw.webContents.getZoomFactor() - 0.05, 0.75);
              bw.webContents.setZoomFactor(next);
              bw.webContents.send('zoom-factor-changed', next);
            }
          },
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
        { type: 'separator' as const },
        {
          label: 'Trigger Test Toast',
          click: () => sendMenuAction('dev:test-toast'),
        },
      ],
    }] : []),
    // Tools menu
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Password Generator',
          accelerator: 'CmdOrCtrl+G',
          click: () => sendMenuAction('password-generator'),
        },
        {
          label: 'SSH Key Generator',
          click: () => sendMenuAction('ssh-key-generator'),
        },
        { type: 'separator' },
        {
          label: 'Close All Sessions',
          click: async () => {
            // Force-close all sessions on the main process (terminals, web, RDP, VNC)
            await AppState.getInstance().closeAllSessions();
            // Notify renderer to clear UI state
            sendMenuAction('close-all-sessions');
          },
        },
      ],
    },
    // Window menu (macOS only — on Windows these actions are on the title bar)
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [
              { role: 'minimize' as const },
              { role: 'zoom' as const },
              { type: 'separator' as const },
              { role: 'front' as const },
            ],
          },
        ]
      : []),
    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Conduit Help',
          accelerator: 'F1',
          click: () => {
            const docsUrl = isDev
              ? 'https://preview.conduitdesktop.com/docs'
              : 'https://conduitdesktop.com/docs';
            shell.openExternal(docsUrl);
          },
        },
        {
          label: 'Getting Started',
          click: () => sendMenuAction('replay-onboarding'),
        },
        {
          label: "What's New",
          click: () => sendMenuAction('whats-new'),
        },
        { type: 'separator' },
        {
          label: 'Submit a Bug...',
          click: () => sendMenuAction('submit-bug'),
        },
        {
          label: 'Submit Feedback...',
          click: () => sendMenuAction('submit-feedback'),
        },
        { type: 'separator' },
        {
          label: downloadedVersion
            ? `Restart to Update to v${downloadedVersion}`
            : 'Check for Updates...',
          click: () => {
            if (downloadedVersion) {
              // Update already downloaded — restart to install
              const win = mainWindowRef;
              if (win) {
                win.webContents.send('menu-action', 'install-update');
              }
            } else {
              sendMenuAction('check-for-updates');
            }
          },
        },
        { type: 'separator' },
        {
          label: 'About Conduit',
          click: () => sendMenuAction('about'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow(): BrowserWindow {
  // Restore saved window bounds from ui-state
  const uiState = readAll();
  const saved = uiState['window-bounds'] as { x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean } | undefined;

  let windowOpts: { x?: number; y?: number; width: number; height: number; center?: boolean } = {
    width: 1280,
    height: 800,
    center: true,
  };

  if (saved) {
    const w = saved.width && saved.width >= 1024 ? saved.width : 1280;
    const h = saved.height && saved.height >= 700 ? saved.height : 800;

    // Validate position is on a visible display
    if (saved.x != null && saved.y != null) {
      const visible = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: w, height: h });
      if (visible) {
        windowOpts = { x: saved.x, y: saved.y, width: w, height: h };
      } else {
        windowOpts = { width: w, height: h, center: true };
      }
    } else {
      windowOpts = { width: w, height: h, center: true };
    }
  }

  const mainWindow = new BrowserWindow({
    ...windowOpts,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f172a',
    title: 'Conduit',
    ...(!isMac && {
      icon: path.join(
        isDev ? path.join(__dirname, '..') : process.resourcesPath,
        isDev ? 'build/icons/icon.ico' : 'icons/icon.ico'
      ),
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    // Apply persisted UI scale
    const settings = readSettings();
    if (settings.ui_scale && settings.ui_scale !== 1.0) {
      mainWindow.webContents.setZoomFactor(settings.ui_scale);
    }
    if (saved?.isMaximized) mainWindow.maximize();
    mainWindow.show();
  });

  // Hide to tray/dock on close instead of quitting.
  // Actual quit happens via app.quit() (Cmd+Q, tray "Quit", etc.).
  mainWindow.on('close', (event) => {
    // Always save window bounds
    const isMaximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds();
    const all = readAll();
    all['window-bounds'] = { ...bounds, isMaximized };
    writeAll(all);

    if (!isQuitting()) {
      event.preventDefault();
      // Lock the vault (backend) before hiding, then notify renderer
      lockVaultFromMain().then(() => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('vault-locked-by-system');
        }
        mainWindow.hide();
      }).catch((err) => {
        console.error('[main] Failed to lock vault on hide:', err);
        mainWindow.hide();
      });
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:1420');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return mainWindow;
}

app.whenReady().then(async () => {
  // Initialize production logging
  const logFile = await logger.init();
  if (logFile) {
    console.log(`[main] Logging to: ${logFile}`);
  }

  registerIpcHandlers();
  buildAppMenu();

  // Fire anonymous telemetry — no-op if POSTHOG_API_KEY isn't set or if
  // the user has opted out in Settings.
  const { track } = await import('./services/analytics.js');
  track('app.launched');

  // Write agent instruction files for external tools (non-blocking, best-effort)
  writeAgentInstructions().catch((err) => {
    console.warn('[main] Failed to write agent instruction files:', err);
  });

  // Kick off FreeRDP build in background (dev only — packaged apps bundle the binary)
  if (isDev) {
    import('./services/rdp/engines/build-helper.js').then(({ startupFreeRdpCheck, watchFreeRdpSources }) => {
      startupFreeRdpCheck();
      const stopWatching = watchFreeRdpSources();
      app.on('before-quit', stopWatching);
    }).catch((err) => {
      console.warn('[main] Failed to start FreeRDP background build:', err);
    });
  }

  // Set native theme from persisted settings
  ipcMain.on('set-native-theme', (_event, theme: string) => {
    if (theme === 'dark' || theme === 'light' || theme === 'system') {
      nativeTheme.themeSource = theme;
    }
  });

  // Live UI scale adjustment from settings
  ipcMain.on('set-zoom-factor', (_event, factor: number) => {
    if (mainWindowRef && !mainWindowRef.isDestroyed() && factor >= 0.75 && factor <= 1.5) {
      mainWindowRef.webContents.setZoomFactor(factor);
      mainWindowRef.webContents.send('zoom-factor-changed', factor);
    }
  });

  ipcMain.handle('get-zoom-factor', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      return mainWindowRef.webContents.getZoomFactor();
    }
    return 1;
  });

  const mainWindow = createWindow();
  mainWindowRef = mainWindow;
  AppState.getInstance().setMainWindow(mainWindow);
  createTray(mainWindow);

  // ── Notification overlay (BrowserWindow + native transparency) ──
  // Transparent overlay window that floats above native WebContentsViews
  // and WebView2 popups. Uses koffi FFI to set NSWindow transparency
  // natively, bypassing Electron's transparent:true GPU compositor issue.
  overlayManager = new OverlayManager(mainWindow);

  // ── Credential Picker IPC + global shortcut ─────────────────────
  ipcMain.handle('picker_close', () => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
  });

  ipcMain.handle('picker_show_main', () => {
    if (pickerWindow && !pickerWindow.isDestroyed()) {
      pickerWindow.close();
    }
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
    }
  });

  try {
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      createPickerWindow();
    });
  } catch (err) {
    console.warn('[main] Failed to register global shortcut for picker:', err);
  }

  // Forward window resize events to renderer so web views can re-sync bounds
  mainWindow.on('resize', () => {
    mainWindow.webContents.send('window-resized');
  });

  // Hide orphaned web session views when the renderer reloads (HMR, manual reload, crash recovery).
  // Native WebContentsViews survive renderer reloads but React state resets, leaving them orphaned.
  let rendererLoaded = false;
  mainWindow.webContents.on('did-finish-load', () => {
    if (rendererLoaded) {
      console.log('[main] Renderer reloaded — hiding orphaned web session views');
      const state = AppState.getInstance();
      state.webManager.hideAll();
      // Clear stale toasts from overlay window
      if (overlayManager) {
        overlayManager.pushState({ toasts: [], update: null });
      }
    }
    rendererLoaded = true;
  });

  // Pull-model IPC: renderer asks for pending vault file on mount
  ipcMain.handle('get_pending_vault_file', () => {
    const fp = pendingFilePath;
    pendingFilePath = null;
    return fp;
  });

  // Windows/Linux first launch: file path comes via process.argv
  if (!isMac) {
    const fileArg = process.argv.find(arg => arg.endsWith('.conduit'));
    if (fileArg) {
      console.log('[main] Found .conduit file in argv:', fileArg);
      pendingFilePath = fileArg;
    }
  }

  // Mark app as ready and process any queued deep links
  appReady = true;
  if (pendingDeepLinkUrl) {
    console.log('[main] Processing queued deep link');
    processDeepLink(pendingDeepLinkUrl);
    pendingDeepLinkUrl = null;
  }

  // IPC socket server for MCP is now managed by McpGatekeeper
  // (starts/stops dynamically based on user's auth state and tier)

  // Check for updates after window is ready (non-blocking)
  // electron-updater uses forceDevUpdateConfig + dev-app-update.yml in dev mode
  {
    setupAutoUpdater().catch((err) => {
      console.error('[updater] setupAutoUpdater failed:', err);
    });

    // Rebuild menu when update is downloaded (dynamic label: "Restart to Update to vX.Y.Z")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.on('conduit:update-downloaded' as any, () => {
      buildAppMenu();
    });
  }

  app.on('activate', () => {
    const win = mainWindowRef;
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow();
      mainWindowRef = newWin;
      AppState.getInstance().setMainWindow(newWin);
    }
  });
});

app.on('window-all-closed', () => {
  // App stays running in tray/dock. Quit via app.quit() (Cmd+Q, tray menu).
});

app.on('before-quit', () => {
  setIsQuitting(true);
  stopPeriodicUpdateChecks();
  globalShortcut.unregisterAll();

  // Destroy tray to release the process on Windows/Linux
  if (tray) {
    tray.destroy();
    tray = null;
  }

  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.close();
    pickerWindow = null;
  }

  if (overlayManager) {
    overlayManager.destroy();
    overlayManager = null;
  }

  // Clean up all sessions and services
  try {
    const state = AppState.getInstance();
    state.webManager.destroyAll();
    state.mcpGatekeeper.shutdown();
    state.vaultLock.cleanup();
    state.networkLock.cleanup();
  } catch {
    // AppState may not be initialized if quitting early
  }

  logger.close();
});
