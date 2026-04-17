import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Duplicated from src/types/toast.ts to avoid cross-rootDir imports.
// Keep in sync with the frontend type definitions.
interface OverlayState {
  toasts: Array<{
    id: string;
    type: 'success' | 'error' | 'warning' | 'info';
    title: string;
    message?: string;
    actions?: Array<{ id: string; label: string; variant?: 'primary' | 'default' }>;
    persistent?: boolean;
    exiting?: boolean;
    progress?: { percent: number; leftLabel?: string; rightLabel?: string; speed?: string };
  }>;
  update: {
    state: 'available' | 'downloading' | 'downloaded' | 'error';
    version: string;
    progress: number;
    body?: string | null;
  } | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;

const OVERLAY_WIDTH = 400;
const OVERLAY_HEIGHT = 500;
const OVERLAY_PADDING = 16;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcHandler = (...args: any[]) => void;

// ── OverlayManager ─────────────────────────────────────────────────

export class OverlayManager {
  private overlayWindow: BrowserWindow | null = null;
  private mainWindow: BrowserWindow;
  private lastState: OverlayState = { toasts: [], update: null };
  private ipcHandlers: Array<[string, IpcHandler]> = [];
  private windowReady = false;
  private blurTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
    this.attachMainWindowListeners();
    this.registerIpcHandlers();
    // Overlay window is created lazily on first toast/update
  }

  /** Create the overlay window on demand (first toast/update). */
  private ensureOverlayWindow(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) return;

    const bounds = this.computeOverlayBounds();

    // Use transparent:true — this is safe for the overlay window since it
    // has no WebContentsViews. The GPU compositor concern only applies to the
    // main window where web sessions are rendered as native views.
    this.overlayWindow = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, '../../preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // Start as click-through
    this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });

    // Float above the main window and its native views.
    this.overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');

    this.windowReady = false;

    if (isDev) {
      this.overlayWindow.loadURL('http://localhost:1420/overlay.html');
    } else {
      this.overlayWindow.loadFile(path.join(__dirname, '../../../dist/overlay.html'));
    }

    this.overlayWindow.webContents.once('did-finish-load', () => {
      this.windowReady = true;
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.webContents.send('overlay:state-updated', this.lastState);
        const hasContent = this.lastState.toasts.length > 0 || this.lastState.update !== null;
        if (hasContent) {
          this.showOverlay();
        }
      }
    });

    this.overlayWindow.on('closed', () => {
      this.overlayWindow = null;
      this.windowReady = false;
    });
  }

  private computeOverlayBounds(): { x: number; y: number } {
    const contentBounds = this.mainWindow.getContentBounds();
    const x = contentBounds.x + contentBounds.width - OVERLAY_WIDTH - OVERLAY_PADDING;
    const y = contentBounds.y + contentBounds.height - OVERLAY_HEIGHT - OVERLAY_PADDING;
    return { x, y };
  }

  private syncPosition(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    if (this.mainWindow.isMinimized()) return;

    const bounds = this.computeOverlayBounds();
    this.overlayWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    });
  }

  private attachMainWindowListeners(): void {
    const sync = () => this.syncPosition();

    this.mainWindow.on('move', sync);
    this.mainWindow.on('resize', sync);
    this.mainWindow.on('maximize', sync);
    this.mainWindow.on('unmaximize', sync);
    this.mainWindow.on('restore', () => {
      sync();
      this.showIfNeeded();
    });
    this.mainWindow.on('enter-full-screen', sync);
    this.mainWindow.on('leave-full-screen', sync);

    this.mainWindow.on('minimize', () => {
      this.hideOverlay();
    });

    this.mainWindow.on('blur', () => {
      // Debounce: clicking the menu bar briefly blurs the window.
      // Only hide if focus doesn't return within 200ms.
      if (this.blurTimeout) clearTimeout(this.blurTimeout);
      this.blurTimeout = setTimeout(() => {
        this.blurTimeout = null;
        if (!this.mainWindow.isFocused()) {
          this.hideOverlay();
        }
      }, 200);
    });

    this.mainWindow.on('focus', () => {
      if (this.blurTimeout) {
        clearTimeout(this.blurTimeout);
        this.blurTimeout = null;
      }
      this.showIfNeeded();
    });

    this.mainWindow.on('hide', () => {
      this.hideOverlay();
    });

    this.mainWindow.on('show', () => {
      this.showIfNeeded();
    });
  }

  private addIpcHandler(channel: string, handler: IpcHandler): void {
    ipcMain.on(channel, handler);
    this.ipcHandlers.push([channel, handler]);
  }

  private registerIpcHandlers(): void {
    this.addIpcHandler('overlay:push-state', (_event, state: OverlayState) => {
      this.applyState(state);
    });

    this.addIpcHandler('overlay:action-clicked', (_event, data: { actionId: string }) => {
      this.mainWindow.webContents.send('overlay:action-clicked', data);
    });

    this.addIpcHandler('overlay:dismiss-toast', (_event, data: { toastId: string }) => {
      this.mainWindow.webContents.send('overlay:dismiss-toast', data);
    });

    this.addIpcHandler('overlay:update-action', (_event, data: { action: string }) => {
      this.mainWindow.webContents.send('overlay:update-action', data);
    });

    this.addIpcHandler('overlay:set-mouse-ignore', (_event, data: { ignore: boolean; forward?: boolean }) => {
      if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
      if (data.ignore) {
        this.overlayWindow.setIgnoreMouseEvents(true, { forward: data.forward ?? true });
      } else {
        this.overlayWindow.setIgnoreMouseEvents(false);
      }
    });
  }

  private applyState(state: OverlayState): void {
    this.lastState = state;

    const hasContent = state.toasts.length > 0 || state.update !== null;
    console.log(`[overlay] applyState: toasts=${state.toasts.length} update=${!!state.update} hasContent=${hasContent} windowReady=${this.windowReady}`);

    if (hasContent) {
      this.ensureOverlayWindow();
      if (this.windowReady) {
        this.showOverlay();
      }
    } else {
      this.hideOverlay();
    }

    if (this.windowReady && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.webContents.send('overlay:state-updated', state);
    }
  }

  private showOverlay(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    if (!this.windowReady) return;
    if (this.mainWindow.isMinimized()) return;
    if (!this.mainWindow.isFocused()) return;

    this.syncPosition();
    if (!this.overlayWindow.isVisible()) {
      this.overlayWindow.setAlwaysOnTop(true, 'pop-up-menu');
      this.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      this.overlayWindow.showInactive();
    }
  }

  private showIfNeeded(): void {
    const hasContent = this.lastState.toasts.length > 0 || this.lastState.update !== null;
    if (hasContent) {
      this.showOverlay();
    }
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed() && this.overlayWindow.isVisible()) {
      this.overlayWindow.setAlwaysOnTop(false);
      this.overlayWindow.hide();
    }
  }

  pushState(state: OverlayState): void {
    this.applyState(state);
  }

  destroy(): void {
    for (const [channel, handler] of this.ipcHandlers) {
      ipcMain.removeListener(channel, handler);
    }
    this.ipcHandlers = [];

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
      this.overlayWindow = null;
    }
    this.windowReady = false;
  }
}
