// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;
interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const electron = vi.hoisted(() => {
  const ipcListeners = new Map<string, Set<Listener>>();

  class FakeWebContents {
    readonly sent: Array<[string, unknown]> = [];
    private readonly onceHandlers = new Map<string, Listener>();
    send(channel: string, data: unknown) {
      this.sent.push([channel, data]);
    }
    on() {}
    once(event: string, cb: Listener) {
      this.onceHandlers.set(event, cb);
    }
    fire(event: string) {
      this.onceHandlers.get(event)?.();
    }
  }

  /** A window the overlay covers: the main window or the credential picker. */
  class FakeHost {
    readonly webContents = new FakeWebContents();
    readonly events = new Map<string, Listener>();
    focused = true;
    destroyed = false;
    constructor(readonly bounds: Bounds) {}
    on(event: string, cb: Listener) {
      this.events.set(event, cb);
    }
    getContentBounds() {
      return this.bounds;
    }
    isMinimized() {
      return false;
    }
    isFocused() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.focused;
    }
    isDestroyed() {
      return this.destroyed;
    }
  }

  const overlays: FakeOverlay[] = [];
  class FakeOverlay {
    readonly webContents = new FakeWebContents();
    bounds: Bounds;
    visible = false;
    closed = false;
    ignoreMouse: unknown[] = [];
    constructor(readonly options: Record<string, unknown>) {
      this.bounds = { x: options.x as number, y: options.y as number, width: options.width as number, height: options.height as number };
      overlays.push(this);
    }
    setIgnoreMouseEvents(...args: unknown[]) {
      this.ignoreMouse.push(args);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadURL() {}
    loadFile() {}
    on() {}
    isDestroyed() {
      return this.closed;
    }
    isVisible() {
      return this.visible;
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    setBounds(bounds: Bounds) {
      this.bounds = bounds;
    }
    close() {
      this.closed = true;
    }
    /** The overlay page finished loading. */
    ready() {
      this.webContents.fire('did-finish-load');
    }
  }

  const ipcMain = {
    on(channel: string, cb: Listener) {
      if (!ipcListeners.has(channel)) ipcListeners.set(channel, new Set());
      ipcListeners.get(channel)!.add(cb);
    },
    removeListener(channel: string, cb: Listener) {
      ipcListeners.get(channel)?.delete(cb);
    },
    emit(channel: string, event: unknown, data: unknown) {
      for (const cb of ipcListeners.get(channel) ?? []) cb(event, data);
    },
    listenerCount(channel: string) {
      return ipcListeners.get(channel)?.size ?? 0;
    },
  };

  return { ipcMain, overlays, FakeHost, FakeOverlay, app: { isPackaged: false, getPath: () => '/tmp' } };
});

vi.mock('electron', () => ({ app: electron.app, ipcMain: electron.ipcMain, BrowserWindow: electron.FakeOverlay }));
vi.mock('../../env-config.js', () => ({ devServerUrl: (page: string) => `http://localhost:0/${page}` }));

import { OverlayManager } from '../overlay-manager.js';

type Host = InstanceType<typeof electron.FakeHost>;
type Overlay = InstanceType<typeof electron.FakeOverlay>;

const toastState = (id: string) => ({
  toasts: [{ id, type: 'success' as const, title: 'Password copied', actions: [{ id: `${id}:0`, label: 'Undo' }] }],
  update: null,
});

let managers: OverlayManager[] = [];
let main: Host;
let picker: Host;

function manage(host: Host, placement?: 'corner' | 'cover'): OverlayManager {
  const manager = new OverlayManager(host as never, placement ? { placement } : undefined);
  managers.push(manager);
  return manager;
}

function overlayFor(host: Host): Overlay {
  const bounds = host.getContentBounds();
  const found = electron.overlays.find((o) => !o.closed && o.bounds.x >= bounds.x && o.bounds.x < bounds.x + bounds.width && o.bounds.y >= bounds.y);
  if (!found) throw new Error('no overlay over that window');
  return found;
}

const sentTo = (host: Host, channel: string) => host.webContents.sent.filter(([c]) => c === channel).map(([, data]) => data);

beforeEach(() => {
  electron.overlays.length = 0;
  main = new electron.FakeHost({ x: 100, y: 50, width: 1280, height: 800 });
  picker = new electron.FakeHost({ x: 1500, y: 30, width: 380, height: 500 });
});

afterEach(() => {
  for (const m of managers) m.destroy();
  managers = [];
  vi.useRealTimers();
});

describe('OverlayManager', () => {
  it("keeps the main window's overlay in its bottom-right corner", () => {
    manage(main);
    electron.ipcMain.emit('overlay:push-state', { sender: main.webContents }, toastState('t1'));
    expect(electron.overlays).toHaveLength(1);
    expect(electron.overlays[0].bounds).toEqual({ x: 100 + 1280 - 400 - 16, y: 50 + 800 - 500 - 16, width: 400, height: 500 });
  });

  it("covers the credential picker with the picker's own overlay and shows its toasts there", () => {
    manage(main);
    manage(picker, 'cover');
    electron.ipcMain.emit('overlay:push-state', { sender: picker.webContents }, toastState('p1'));

    expect(electron.overlays).toHaveLength(1);
    const overlay = electron.overlays[0];
    expect(overlay.bounds).toEqual(picker.bounds);
    overlay.ready();
    expect(overlay.visible).toBe(true);
    expect(overlay.webContents.sent).toContainEqual(['overlay:state-updated', toastState('p1')]);
  });

  it('takes toast state only from its own window', () => {
    manage(main);
    manage(picker, 'cover');
    electron.ipcMain.emit('overlay:push-state', { sender: main.webContents }, toastState('m1'));
    electron.ipcMain.emit('overlay:push-state', { sender: picker.webContents }, toastState('p1'));
    const mainOverlay = overlayFor(main);
    const pickerOverlay = overlayFor(picker);
    mainOverlay.ready();
    pickerOverlay.ready();
    expect(mainOverlay.webContents.sent.at(-1)).toEqual(['overlay:state-updated', toastState('m1')]);
    expect(pickerOverlay.webContents.sent.at(-1)).toEqual(['overlay:state-updated', toastState('p1')]);
  });

  it('sends a click on a toast back to the window that raised it, also without a sender (the harness)', () => {
    manage(main);
    manage(picker, 'cover');
    electron.ipcMain.emit('overlay:push-state', { sender: main.webContents }, toastState('m1'));
    electron.ipcMain.emit('overlay:push-state', { sender: picker.webContents }, toastState('p1'));

    electron.ipcMain.emit('overlay:action-clicked', { sender: overlayFor(picker).webContents }, { actionId: 'p1:0' });
    electron.ipcMain.emit('overlay:dismiss-toast', { sender: null }, { toastId: 'p1' });
    electron.ipcMain.emit('overlay:action-clicked', { sender: null }, { actionId: 'm1:0' });

    expect(sentTo(picker, 'overlay:action-clicked')).toEqual([{ actionId: 'p1:0' }]);
    expect(sentTo(picker, 'overlay:dismiss-toast')).toEqual([{ toastId: 'p1' }]);
    expect(sentTo(main, 'overlay:action-clicked')).toEqual([{ actionId: 'm1:0' }]);
    expect(sentTo(main, 'overlay:dismiss-toast')).toEqual([]);
  });

  it('lets only its own overlay page switch its click-through', () => {
    manage(main);
    manage(picker, 'cover');
    electron.ipcMain.emit('overlay:push-state', { sender: main.webContents }, toastState('m1'));
    electron.ipcMain.emit('overlay:push-state', { sender: picker.webContents }, toastState('p1'));
    const mainOverlay = overlayFor(main);
    const pickerOverlay = overlayFor(picker);
    const before = mainOverlay.ignoreMouse.length;

    electron.ipcMain.emit('overlay:set-mouse-ignore', { sender: pickerOverlay.webContents }, { ignore: false });
    expect(pickerOverlay.ignoreMouse.at(-1)).toEqual([false]);
    expect(mainOverlay.ignoreMouse).toHaveLength(before);
  });

  it('closes its overlay and stops listening when the picker closes, even right after a blur', () => {
    vi.useFakeTimers();
    manage(main);
    const pickerManager = manage(picker, 'cover');
    electron.ipcMain.emit('overlay:push-state', { sender: picker.webContents }, toastState('p1'));
    const overlay = overlayFor(picker);

    picker.focused = false;
    picker.events.get('blur')?.();
    picker.destroyed = true;
    pickerManager.destroy();
    managers = managers.filter((m) => m !== pickerManager);

    expect(overlay.closed).toBe(true);
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(electron.ipcMain.listenerCount('overlay:push-state')).toBe(1);
  });
});
