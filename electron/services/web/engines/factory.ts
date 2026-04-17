/**
 * Web engine factory — resolves which web rendering engine to use.
 *
 * On Windows, the WebView2 helper binary provides native Edge WebView2 rendering.
 * On macOS/Linux (or when the helper is unavailable), Electron's built-in
 * Chromium WebContentsView is used instead.
 *
 * Follows the same pattern as the RDP engine factory at
 * electron/services/rdp/engines/factory.ts.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

export type WebEngineType = 'auto' | 'chromium' | 'webview2';

/** Check if the WebView2 helper binary is available */
export function isWebView2Available(): boolean {
  const binaryPath = getWebView2BinaryPath();
  const exists = process.platform === 'win32' && existsSync(binaryPath);
  console.log(`[WebEngine] isWebView2Available: platform=${process.platform}, path=${binaryPath}, exists=${exists}`);
  return exists;
}

/** Get the path to the conduit-webview2 helper binary */
export function getWebView2BinaryPath(): string {
  const isDev = !app.isPackaged;
  if (isDev) {
    // Development: architecture-specific bundle
    const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
    return join(app.getAppPath(), 'webview2-helper', 'bundle', arch, 'ConduitWebView2.exe');
  }
  // Production: bundled in resources/webview2/
  return join(process.resourcesPath, 'webview2', 'ConduitWebView2.exe');
}

/** Resolve engine type based on availability and preference */
export function resolveWebEngine(type: WebEngineType): 'chromium' | 'webview2' {
  let resolved: 'chromium' | 'webview2';
  if (type === 'auto') {
    resolved = isWebView2Available() ? 'webview2' : 'chromium';
  } else if (type === 'webview2' && !isWebView2Available()) {
    resolved = 'chromium';
  } else {
    resolved = type as 'chromium' | 'webview2';
  }
  console.log(`[WebEngine] resolveWebEngine: requested=${type}, resolved=${resolved}`);
  return resolved;
}
