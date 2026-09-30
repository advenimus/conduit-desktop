/**
 * The app's one quit flush of the personal vault (quit-flush.ts): main.ts runs it on before-quit
 * and the update install runs it before quitAndInstall, so both share one flush.
 */

import { app } from 'electron';
import { AppState } from '../state.js';
import { QUIT_FLUSH_CAP_MS } from '../sync/app-sync-manager.js';
import { createQuitFlush, QUIT_FLUSH_MARGIN_MS, type QuitFlush } from './quit-flush.js';

let instance: QuitFlush | null = null;

export function appQuitFlush(): QuitFlush {
  instance ??= createQuitFlush({
    needsFlush: () => AppState.getInstance().appSync.hasSession(),
    flush: () => AppState.getInstance().appSync.quit(),
    quit: () => app.quit(),
    capMs: QUIT_FLUSH_CAP_MS + QUIT_FLUSH_MARGIN_MS,
  });
  return instance;
}
