import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devServerUrl } from '../env-config.js';

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
const isMac = process.platform === 'darwin';

const OVERLAY_WIDTH = 400;
const OVERLAY_HEIGHT = 500;
const OVERLAY_PADDING = 16;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcHandler = (...args: any[]) => void;

interface OverlaySender {
  sender?: Electron.WebContents | null;
}

/**
 * Where the overlay sits over its host window: `corner` is the main window's 400 x 500 column at
 * the bottom-right; `cover` fills the host's content area (the credential picker, which is smaller).
 */
export type OverlayPlacement = 'corner' | 'cover';

export interface OverlayManagerOptions {
  placement?: OverlayPlacement;
}

// ── OverlayManager ─────────────────────────────────────────────────

/**
 * The toast overlay of one host window. Each host (the main window, an open credential picker) has its
 * own manager: a manager takes toast state only from its host's renderer and sends clicks on its
 * toasts back to that renderer, so the channels below are shared without crossing windows.
 */
export class OverlayManager {
  private overlayWindow: BrowserWindow | null = null;
  private mainWindow: BrowserWindow;
  private readonly placement: OverlayPlacement;
  private lastState: OverlayState = { toasts: [], update: null };
  private ipcHandlers: Array<[string, IpcHandler]> = [];
  private windowReady = false;
  private blurTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(mainWindow: BrowserWindow, { placement = 'corner' }: OverlayManagerOptions = {}) {
    this.mainWindow = mainWindow;
    this.placement = placement;
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
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      // Electron 43+ rounds frameless windows on Linux by default; these draw their own shape.
      ...(process.platform === 'linux' ? { roundedCorners: false } : {}),
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

    // macOS: appear on whatever Space the user is currently on. Without this,
    // creating an alwaysOnTop window can yank the user across Spaces when the
    // first toast surfaces.
    // skipTransformProcessType: true avoids the transient Foreground↔Accessory
    // policy churn that can strand the app as accessory (no dock icon, no
    // menu bar ownership) — a documented side effect on macOS that the toast
    // panel does not need.
    if (isMac) {
      this.overlayWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    this.windowReady = false;

    if (isDev) {
      this.overlayWindow.loadURL(devServerUrl('overlay.html'));
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

  private computeOverlayBounds(): { x: number; y: number; width: number; height: number } {
    const contentBounds = this.mainWindow.getContentBounds();
    if (this.placement === 'cover') return contentBounds;
    const x = contentBounds.x + contentBounds.width - OVERLAY_WIDTH - OVERLAY_PADDING;
    const y = contentBounds.y + contentBounds.height - OVERLAY_HEIGHT - OVERLAY_PADDING;
    return { x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT };
  }

  private syncPosition(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    if (this.mainWindow.isDestroyed() || this.mainWindow.isMinimized()) return;

    this.overlayWindow.setBounds(this.computeOverlayBounds());
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
        if (!this.mainWindow.isDestroyed() && !this.mainWindow.isFocused()) {
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

  private isFromHost(event: OverlaySender): boolean {
    return !this.mainWindow.isDestroyed() && event.sender === this.mainWindow.webContents;
  }

  private isFromOverlay(event: OverlaySender): boolean {
    return !!this.overlayWindow && !this.overlayWindow.isDestroyed() && event.sender === this.overlayWindow.webContents;
  }

  /** Clicks are matched to the toast they belong to, not to their sender: the harness sends them without one. */
  private ownsToast(toastId: string): boolean {
    return this.lastState.toasts.some((t) => t.id === toastId);
  }

  private sendToHost(channel: string, data: unknown): void {
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send(channel, data);
  }

  private registerIpcHandlers(): void {
    this.addIpcHandler('overlay:push-state', (event: OverlaySender, state: OverlayState) => {
      if (this.isFromHost(event)) this.applyState(state);
    });

    this.addIpcHandler('overlay:action-clicked', (_event, data: { actionId: string }) => {
      const toastId = String(data?.actionId ?? '').split(':')[0];
      if (this.ownsToast(toastId)) this.sendToHost('overlay:action-clicked', data);
    });

    this.addIpcHandler('overlay:dismiss-toast', (_event, data: { toastId: string }) => {
      if (this.ownsToast(data?.toastId)) this.sendToHost('overlay:dismiss-toast', data);
    });

    this.addIpcHandler('overlay:update-action', (_event, data: { action: string }) => {
      if (this.lastState.update !== null) this.sendToHost('overlay:update-action', data);
    });

    this.addIpcHandler('overlay:set-mouse-ignore', (event: OverlaySender, data: { ignore: boolean; forward?: boolean }) => {
      if (!this.isFromOverlay(event) || !this.overlayWindow) return;
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
    if (this.mainWindow.isDestroyed() || this.mainWindow.isMinimized()) return;
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
    if (this.blurTimeout) {
      clearTimeout(this.blurTimeout);
      this.blurTimeout = null;
    }
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
