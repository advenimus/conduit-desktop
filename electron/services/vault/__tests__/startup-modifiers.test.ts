// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { silenceConsole } from '../../../ipc/__tests__/sync-fakes.js';
import { MODIFIER_WINDOW_MS, StartupSkip, modifierFlagsHeld, probeMacModifiers } from '../startup-modifiers.js';

const key = (shift: boolean, alt = false) => ({ type: 'keyDown', shift, alt });

beforeEach(() => silenceConsole());

describe('modifier flags (spec 4.5)', () => {
  it('reads Shift and Option, and nothing else', () => {
    expect(modifierFlagsHeld('131072\n')).toBe(true);
    expect(modifierFlagsHeld(String(0x80000))).toBe(true);
    expect(modifierFlagsHeld(String(0x20000 | 0x80000))).toBe(true);
    expect(modifierFlagsHeld('0')).toBe(false);
    expect(modifierFlagsHeld(String(0x100000))).toBe(false);
    expect(modifierFlagsHeld('garbage')).toBe(false);
  });

  it('a probe timeout or error means not held, and the probe runs once per call', async () => {
    const run = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect(await probeMacModifiers(run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await probeMacModifiers(async () => '131072')).toBe(true);
  });
});

describe('StartupSkip', () => {
  it('the switch always skips', () => {
    expect(new StartupSkip('linux', true).isSkipRequested()).toBe(true);
  });

  it('counts Shift everywhere, and Option only on macOS', () => {
    const mac = new StartupSkip('darwin', false);
    mac.startCollector(0);
    mac.noteInput(key(false, true), 100);
    expect(mac.isSkipRequested()).toBe(true);
    const win = new StartupSkip('win32', false);
    win.startCollector(0);
    win.noteInput(key(false, true), 100);
    expect(win.isSkipRequested()).toBe(false);
    win.noteInput(key(true), 200);
    expect(win.isSkipRequested()).toBe(true);
  });

  it('ignores events after the window and after a focus report (typing on the sign-in screen)', () => {
    const s = new StartupSkip('win32', false);
    s.startCollector(0);
    expect(s.noteInput(key(true), MODIFIER_WINDOW_MS + 1)).toBe(false);
    expect(s.isSkipRequested()).toBe(false);
    s.rearm(10_000);
    s.noteInputFocus();
    expect(s.noteInput(key(true), 10_100)).toBe(false);
    expect(s.isSkipRequested()).toBe(false);
  });

  it('events before the window opens do not count', () => {
    const s = new StartupSkip('linux', false);
    expect(s.noteInput(key(true), 0)).toBe(false);
    expect(s.isSkipRequested()).toBe(false);
  });

  it('the probe result counts until a re-arm clears it', () => {
    const s = new StartupSkip('darwin', false);
    s.setProbeResult(true);
    expect(s.isSkipRequested()).toBe(true);
    s.rearm(0);
    expect(s.isSkipRequested()).toBe(false);
    expect(s.remainingMs(500)).toBe(MODIFIER_WINDOW_MS - 500);
    expect(s.remainingMs(MODIFIER_WINDOW_MS)).toBe(0);
  });
});
