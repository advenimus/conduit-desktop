/**
 * Auto-build helper for the conduit-freerdp binary.
 *
 * Detects when the FreeRDP helper binary is missing and builds it automatically.
 * Supports macOS, Windows, and Linux with platform-specific build scripts.
 *
 * Build phases:
 *   1. Dependencies (OpenSSL, FFmpeg, FreeRDP) — first-time only, 10-20 minutes (macOS/Linux)
 *      Windows uses native SChannel/MediaFoundation, so only builds FreeRDP (~5 min)
 *   2. Helper binary (cmake + ninja) — fast, ~5 seconds when deps exist
 */

import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { getFreeRdpBinaryPath } from './factory.js';

export interface BuildProgress {
  phase: 'checking' | 'deps' | 'binary' | 'done' | 'error';
  message: string;
  detail?: string;
}

/** Singleton build promise — prevents concurrent builds */
let buildInProgress: Promise<boolean> | null = null;

function getHelperDir(): string {
  return join(app.getAppPath(), 'freerdp-helper');
}

function depsExist(): boolean {
  const prefix = join(getHelperDir(), 'deps', 'install');
  if (process.platform === 'win32') {
    return existsSync(join(prefix, 'lib', 'freerdp0.lib'));
  }
  const ext = process.platform === 'linux' ? 'so' : 'dylib';
  return existsSync(join(prefix, 'lib', `libfreerdp0.${ext}`));
}

function emitProgress(progress: BuildProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('freerdp:build-progress', progress);
  }
  console.log(`[FreeRDP Build] [${progress.phase}] ${progress.message}${progress.detail ? ` — ${progress.detail}` : ''}`);
}

function runBuildScript(
  command: string,
  args: string[],
  cwd: string,
  phase: BuildProgress['phase'],
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let output = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      const lines = text.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        emitProgress({ phase, message: `Building...`, detail: lastLine.slice(0, 200) });
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, output });
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: err.message });
    });
  });
}

/**
 * Ensure the FreeRDP helper binary is available, building it if necessary.
 *
 * Safe to call multiple times — concurrent calls share the same build promise.
 */
export async function ensureFreeRdpBinary(): Promise<{ available: boolean; message: string }> {
  // Already available — fast path
  if (existsSync(getFreeRdpBinaryPath())) {
    return { available: true, message: 'FreeRDP helper binary found' };
  }

  // Production builds must have the binary bundled — can't build at runtime
  if (app.isPackaged) {
    return {
      available: false,
      message: 'FreeRDP helper binary not found in application bundle. Please reinstall the app.',
    };
  }

  // Coalesce concurrent build requests
  if (buildInProgress) {
    const result = await buildInProgress;
    return {
      available: result,
      message: result ? 'FreeRDP helper built successfully' : 'FreeRDP build failed',
    };
  }

  buildInProgress = doBuild();
  try {
    const result = await buildInProgress;
    return {
      available: result,
      message: result ? 'FreeRDP helper built successfully' : 'FreeRDP build failed',
    };
  } finally {
    buildInProgress = null;
  }
}

/**
 * Returns the current in-progress build promise, if any.
 * Callers can await this without triggering a new build.
 */
export function getBuildPromise(): Promise<boolean> | null {
  return buildInProgress;
}

/**
 * Fire-and-forget startup check: kicks off FreeRDP binary build if missing.
 * Logs result but never throws — safe for app startup.
 */
export async function startupFreeRdpCheck(): Promise<void> {
  try {
    const result = await ensureFreeRdpBinary();
    if (result.available) {
      console.log('[FreeRDP Build] Binary ready at startup');
    } else {
      console.warn('[FreeRDP Build] Binary not available at startup:', result.message);
    }
  } catch (err) {
    console.warn('[FreeRDP Build] Startup check failed:', err);
  }
}

/**
 * Dev-mode file watcher: rebuilds FreeRDP helper when source files change.
 * Returns a cleanup function to stop watching.
 */
export function watchFreeRdpSources(): () => void {
  const helperDir = getHelperDir();
  const srcDir = join(helperDir, 'src');
  const cmakeLists = join(helperDir, 'CMakeLists.txt');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const triggerRebuild = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log('[FreeRDP Build] Source change detected, rebuilding...');
      // Reset build singleton so a fresh build runs
      buildInProgress = null;
      ensureFreeRdpBinary().catch((err) => {
        console.warn('[FreeRDP Build] Rebuild after source change failed:', err);
      });
    }, 500);
  };

  const watchers: ReturnType<typeof watch>[] = [];

  // Watch src/ directory recursively
  if (existsSync(srcDir)) {
    try {
      watchers.push(watch(srcDir, { recursive: true }, triggerRebuild));
    } catch {
      // Recursive watch not supported on all platforms
      watchers.push(watch(srcDir, triggerRebuild));
    }
  }

  // Watch CMakeLists.txt
  if (existsSync(cmakeLists)) {
    watchers.push(watch(cmakeLists, triggerRebuild));
  }

  console.log('[FreeRDP Build] Watching source files for changes');

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) w.close();
  };
}

async function doBuild(): Promise<boolean> {
  const helperDir = getHelperDir();

  try {
    if (process.platform === 'win32') {
      return await doBuildWindows(helperDir);
    } else if (process.platform === 'linux') {
      return await doBuildUnix(helperDir, 'linux');
    } else {
      return await doBuildUnix(helperDir, 'macos');
    }
  } catch (err) {
    emitProgress({ phase: 'error', message: `Build error: ${err}` });
    return false;
  }
}

async function doBuildWindows(helperDir: string): Promise<boolean> {
  // Windows: single PowerShell script handles deps + build + bundle
  emitProgress({
    phase: 'deps',
    message: 'Building FreeRDP and conduit-freerdp (Windows)...',
  });

  const result = await runBuildScript(
    'powershell.exe',
    ['-ExecutionPolicy', 'Bypass', '-File', join(helperDir, 'scripts', 'build-windows.ps1')],
    helperDir,
    'binary',
  );

  if (!result.success) {
    const tail = result.output.slice(-500).trim();
    emitProgress({ phase: 'error', message: 'Windows build failed', detail: tail });
    return false;
  }

  if (existsSync(getFreeRdpBinaryPath())) {
    emitProgress({ phase: 'done', message: 'FreeRDP helper built and bundled successfully' });
    return true;
  }

  emitProgress({ phase: 'error', message: 'Build completed but binary not found at expected path' });
  return false;
}

async function doBuildUnix(helperDir: string, platform: 'macos' | 'linux'): Promise<boolean> {
  const needsDeps = !depsExist();

  if (needsDeps) {
    emitProgress({
      phase: 'deps',
      message: 'Building FreeRDP dependencies from source (first-time setup, ~10-20 minutes)...',
    });

    const result = await runBuildScript(
      'bash',
      [join(helperDir, 'build-freerdp.sh')],
      helperDir,
      'deps',
    );

    if (!result.success) {
      const tail = result.output.slice(-500).trim();
      emitProgress({ phase: 'error', message: 'Failed to build FreeRDP dependencies', detail: tail });
      return false;
    }
  }

  if (platform === 'macos') {
    // macOS: separate build + bundle scripts
    emitProgress({ phase: 'binary', message: 'Building conduit-freerdp helper binary...' });

    const buildResult = await runBuildScript(
      'bash',
      [join(helperDir, 'scripts', 'build-macos.sh')],
      helperDir,
      'binary',
    );

    if (!buildResult.success) {
      const tail = buildResult.output.slice(-500).trim();
      emitProgress({ phase: 'error', message: 'Failed to build helper binary', detail: tail });
      return false;
    }

    emitProgress({ phase: 'binary', message: 'Creating self-contained bundle...' });

    const bundleResult = await runBuildScript(
      'bash',
      [join(helperDir, 'scripts', 'bundle-macos.sh')],
      helperDir,
      'binary',
    );

    if (!bundleResult.success) {
      const tail = bundleResult.output.slice(-500).trim();
      emitProgress({ phase: 'error', message: 'Failed to create bundle', detail: tail });
      return false;
    }
  } else {
    // Linux: combined build + bundle script
    emitProgress({ phase: 'binary', message: 'Building and bundling conduit-freerdp (Linux)...' });

    const buildResult = await runBuildScript(
      'bash',
      [join(helperDir, 'scripts', 'build-linux.sh')],
      helperDir,
      'binary',
    );

    if (!buildResult.success) {
      const tail = buildResult.output.slice(-500).trim();
      emitProgress({ phase: 'error', message: 'Linux build failed', detail: tail });
      return false;
    }
  }

  // Verify the bundle binary appeared
  if (existsSync(getFreeRdpBinaryPath())) {
    emitProgress({ phase: 'done', message: 'FreeRDP helper built and bundled successfully' });
    return true;
  }

  emitProgress({ phase: 'error', message: 'Bundle completed but binary not found at expected path' });
  return false;
}
