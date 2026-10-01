import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { FULL_SCREEN_CHANNEL, reportFullScreen, titleBarOptions } from '../window-title-bar.js';

function fakeWindow() {
  const win = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { send: ReturnType<typeof vi.fn> } };
  const webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  let fullScreen = false;
  Object.assign(win, {
    webContents,
    isDestroyed: () => false,
    isFullScreen: () => fullScreen,
    setFull: (v: boolean) => { fullScreen = v; },
  });
  return win as typeof win & { setFull: (v: boolean) => void };
}

describe('titleBarOptions', () => {
  it('hides the macOS title bar and places the window buttons in the app bar', () => {
    expect(titleBarOptions('darwin')).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 12 } });
  });

  it('keeps the native frame on Windows and Linux', () => {
    expect(titleBarOptions('win32')).toEqual({});
    expect(titleBarOptions('linux')).toEqual({});
  });
});

describe('reportFullScreen', () => {
  it('tells the renderer when full screen starts, ends, and after each load', () => {
    const win = fakeWindow();
    reportFullScreen(win as unknown as BrowserWindow);

    win.setFull(true);
    win.emit('enter-full-screen');
    win.setFull(false);
    win.emit('leave-full-screen');
    win.webContents.emit('did-finish-load');

    expect(win.webContents.send.mock.calls).toEqual([
      [FULL_SCREEN_CHANNEL, true],
      [FULL_SCREEN_CHANNEL, false],
      [FULL_SCREEN_CHANNEL, false],
    ]);
  });
});
