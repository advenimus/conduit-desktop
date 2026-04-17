/**
 * RDP engine factory — creates the FreeRDP engine.
 *
 * Supports auto-building the FreeRDP helper binary in development.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { RdpEngine } from '../engine.js';
import { FreeRdpEngine } from './freerdp.js';
import { ensureFreeRdpBinary, getBuildPromise } from './build-helper.js';

/** Check if the FreeRDP helper binary is available on this system */
export function isFreeRdpAvailable(): boolean {
  const binaryPath = getFreeRdpBinaryPath();
  return existsSync(binaryPath);
}

/** Get the path to the conduit-freerdp helper binary */
export function getFreeRdpBinaryPath(): string {
  const isDev = !app.isPackaged;
  const binaryName = process.platform === 'win32' ? 'conduit-freerdp.exe' : 'conduit-freerdp';

  if (isDev) {
    // Development: use pre-built bundle (same structure as production)
    const platformDir = process.platform === 'win32' ? 'win32'
                      : process.platform === 'linux' ? 'linux'
                      : 'darwin';
    return join(app.getAppPath(), 'freerdp-helper', 'bundle', platformDir, binaryName);
  } else {
    // Production: bundled in resources/freerdp/
    return join(process.resourcesPath, 'freerdp', binaryName);
  }
}

/**
 * Ensure the FreeRDP helper binary is available, with auto-build support.
 *
 * If the binary is missing, attempts to build it automatically in development mode.
 * Throws if the binary is unavailable and cannot be built.
 */
export async function ensureFreeRdpReady(): Promise<void> {
  // If a startup build is in progress, wait for it first
  const pending = getBuildPromise();
  if (pending) {
    await pending;
  }

  if (isFreeRdpAvailable()) {
    return;
  }

  // Binary missing — attempt auto-build
  const buildResult = await ensureFreeRdpBinary();

  if (!buildResult.available) {
    throw new Error(
      `FreeRDP engine is not available and auto-build failed: ${buildResult.message}`
    );
  }
}

/**
 * Create a FreeRDP engine instance.
 */
export function createRdpEngine(): RdpEngine {
  return new FreeRdpEngine();
}
