import { listenSync } from "./electron";

const FULL_SCREEN_CHANNEL = "window-full-screen-changed";

/** Whether this window draws its own top bar under the macOS window buttons (electron/window-title-bar.ts). */
export function hasInsetTitleBar(platform: string | undefined = window.electron?.platform): boolean {
  return platform === "darwin";
}

/**
 * Marks the root for the inset title bar styles (styles/components/titlebar.css) and keeps
 * `data-fullscreen` in step with the window, since the window buttons hide in full screen.
 */
export function installTitleBar(root: HTMLElement = document.documentElement): void {
  if (!hasInsetTitleBar()) return;
  root.dataset.titlebar = "inset";
  listenSync<boolean>(FULL_SCREEN_CHANNEL, ({ payload }) => {
    if (payload) root.dataset.fullscreen = "";
    else delete root.dataset.fullscreen;
  });
}
