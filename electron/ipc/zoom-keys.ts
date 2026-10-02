import { ipcMain, type BrowserWindow, type Input, type WebContents } from 'electron';

export type ZoomKey = 'in' | 'out' | 'reset';

/** Sent to the renderer for every zoom key; it zooms the focused agent terminal or hands the key back. */
export const ZOOM_KEY_EVENT = 'zoom-key';
/** The renderer's answer when focus is outside the agent terminals. */
export const APP_ZOOM_KEY_EVENT = 'zoom-key-app';

const APP_ZOOM_MIN = 0.75;
const APP_ZOOM_MAX = 1.5;
const APP_ZOOM_STEP = 0.05;

const ZOOM_BY_CODE: Readonly<Record<string, ZoomKey>> = {
  Equal: 'in',
  NumpadAdd: 'in',
  Minus: 'out',
  NumpadSubtract: 'out',
  Digit0: 'reset',
  Numpad0: 'reset',
};

// Layouts that put these characters on other physical keys still zoom by the character.
const ZOOM_BY_KEY: Readonly<Record<string, ZoomKey>> = { '=': 'in', '+': 'in', '-': 'out', '0': 'reset' };

/** Cmd (macOS) or Ctrl (elsewhere) with +, - or 0. */
export function zoomKeyOf(input: Pick<Input, 'type' | 'code' | 'key' | 'meta' | 'control' | 'alt'>, isMac: boolean): ZoomKey | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const primary = isMac ? input.meta && !input.control : input.control && !input.meta;
  return primary ? ZOOM_BY_CODE[input.code] ?? ZOOM_BY_KEY[input.key] ?? null : null;
}

export function stepAppZoom(contents: WebContents, zoom: ZoomKey): void {
  const current = contents.getZoomFactor();
  const next =
    zoom === 'reset' ? 1
      : zoom === 'in' ? Math.min(current + APP_ZOOM_STEP, APP_ZOOM_MAX)
        : Math.max(current - APP_ZOOM_STEP, APP_ZOOM_MIN);
  contents.setZoomFactor(next);
  contents.send('zoom-factor-changed', next);
}

// The keys are taken here, before the page and the menu see them, because a menu accelerator can
// fire even when the page cancels the key, and then a terminal and the whole app would both zoom.
export function installZoomKeys(win: BrowserWindow, isMac = process.platform === 'darwin'): void {
  win.webContents.on('before-input-event', (event, input) => {
    const zoom = zoomKeyOf(input, isMac);
    if (!zoom) return;
    event.preventDefault();
    win.webContents.send(ZOOM_KEY_EVENT, zoom);
  });
}

/** appZoom false keeps the keys from zooming the whole app, as in packaged builds today. */
export function registerAppZoomKeyHandler(appZoom: boolean): void {
  ipcMain.on(APP_ZOOM_KEY_EVENT, (event, zoom: unknown) => {
    if (!appZoom || (zoom !== 'in' && zoom !== 'out' && zoom !== 'reset')) return;
    stepAppZoom(event.sender, zoom);
  });
}
