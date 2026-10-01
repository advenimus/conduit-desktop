import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

export const FULL_SCREEN_CHANNEL = 'window-full-screen-changed';

// Centers the window buttons in the renderer's 38px top bar (--c-tabstrip-h).
const TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 14, y: 12 });

/** macOS draws the window buttons over the app's own top bar; other platforms keep their native frame. */
export function titleBarOptions(platform: NodeJS.Platform): Partial<BrowserWindowConstructorOptions> {
  if (platform !== 'darwin') return {};
  return { titleBarStyle: 'hidden', trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } };
}

/** The window buttons hide in full screen, so the renderer drops the space it keeps for them. */
export function reportFullScreen(win: BrowserWindow): void {
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send(FULL_SCREEN_CHANNEL, win.isFullScreen());
  };
  win.on('enter-full-screen', send);
  win.on('leave-full-screen', send);
  win.webContents.on('did-finish-load', send);
}
