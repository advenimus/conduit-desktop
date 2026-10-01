// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>());
vi.mock('electron', () => ({
  ipcMain: { on: (channel: string, fn: (...args: unknown[]) => void) => ipcHandlers.set(channel, fn) },
}));

import { APP_ZOOM_KEY_EVENT, ZOOM_KEY_EVENT, installZoomKeys, registerAppZoomKeyHandler, stepAppZoom, zoomKeyOf } from '../zoom-keys.js';

const key = (code: string, mods: { meta?: boolean; control?: boolean; alt?: boolean; key?: string } = {}, type = 'keyDown') =>
  ({ type, code, key: '', meta: false, control: false, alt: false, ...mods });

function fakeContents(factor = 1) {
  const emitter = new EventEmitter();
  let zoom = factor;
  return Object.assign(emitter, {
    getZoomFactor: () => zoom,
    setZoomFactor: vi.fn((f: number) => { zoom = f; }),
    send: vi.fn(),
  });
}

describe('zoomKeyOf', () => {
  it('reads Cmd with +, - and 0 on macOS', () => {
    expect(zoomKeyOf(key('Equal', { meta: true }), true)).toBe('in');
    expect(zoomKeyOf(key('NumpadAdd', { meta: true }), true)).toBe('in');
    expect(zoomKeyOf(key('Minus', { meta: true }), true)).toBe('out');
    expect(zoomKeyOf(key('Digit0', { meta: true }), true)).toBe('reset');
  });

  it('falls back to the character for other keyboard layouts', () => {
    expect(zoomKeyOf(key('BracketRight', { meta: true, key: '+' }), true)).toBe('in');
    expect(zoomKeyOf(key('Slash', { meta: true, key: '-' }), true)).toBe('out');
  });

  it('reads Ctrl instead of Cmd on Windows and Linux', () => {
    expect(zoomKeyOf(key('Equal', { control: true }), false)).toBe('in');
    expect(zoomKeyOf(key('Equal', { meta: true }), false)).toBeNull();
  });

  it('leaves other keys, key ups, Alt combos and Ctrl on macOS alone', () => {
    expect(zoomKeyOf(key('Minus', { control: true }), true)).toBeNull();
    expect(zoomKeyOf(key('Minus', { meta: true, alt: true }), true)).toBeNull();
    expect(zoomKeyOf(key('KeyA', { meta: true }), true)).toBeNull();
    expect(zoomKeyOf(key('Minus'), true)).toBeNull();
    expect(zoomKeyOf(key('Equal', { meta: true }, 'keyUp'), true)).toBeNull();
  });
});

describe('stepAppZoom', () => {
  it('steps by 0.05 within 0.75 to 1.5 and resets to 1, telling the page', () => {
    const contents = fakeContents(1.5);
    stepAppZoom(contents as never, 'in');
    expect(contents.getZoomFactor()).toBe(1.5);
    stepAppZoom(contents as never, 'out');
    expect(contents.getZoomFactor()).toBeCloseTo(1.45);
    stepAppZoom(contents as never, 'reset');
    expect(contents.getZoomFactor()).toBe(1);
    expect(contents.send).toHaveBeenLastCalledWith('zoom-factor-changed', 1);
  });
});

describe('installZoomKeys', () => {
  it('takes zoom keys from the page and the menu and hands them to the renderer', () => {
    const contents = fakeContents();
    installZoomKeys({ webContents: contents } as never, true);
    const zoomEvent = { preventDefault: vi.fn() };
    contents.emit('before-input-event', zoomEvent, key('Equal', { meta: true }));
    expect(zoomEvent.preventDefault).toHaveBeenCalled();
    expect(contents.send).toHaveBeenCalledWith(ZOOM_KEY_EVENT, 'in');

    const typing = { preventDefault: vi.fn() };
    contents.emit('before-input-event', typing, key('KeyA', { meta: true }));
    expect(typing.preventDefault).not.toHaveBeenCalled();
    expect(contents.send).toHaveBeenCalledTimes(1);
    expect(contents.getZoomFactor()).toBe(1);
  });
});

describe('registerAppZoomKeyHandler', () => {
  beforeEach(() => ipcHandlers.clear());

  it('zooms the sending window when app zoom is on', () => {
    registerAppZoomKeyHandler(true);
    const contents = fakeContents();
    ipcHandlers.get(APP_ZOOM_KEY_EVENT)!({ sender: contents }, 'in');
    expect(contents.getZoomFactor()).toBeCloseTo(1.05);
    ipcHandlers.get(APP_ZOOM_KEY_EVENT)!({ sender: contents }, 'sideways');
    expect(contents.getZoomFactor()).toBeCloseTo(1.05);
  });

  it('does nothing when app zoom is off, as in packaged builds', () => {
    registerAppZoomKeyHandler(false);
    const contents = fakeContents();
    ipcHandlers.get(APP_ZOOM_KEY_EVENT)!({ sender: contents }, 'in');
    expect(contents.setZoomFactor).not.toHaveBeenCalled();
  });
});
