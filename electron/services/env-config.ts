/**
 * Environment configuration for the Electron main process.
 *
 * Resolves the Appwrite endpoint and project, and the website URL. Dev builds follow the
 * CONDUIT_ENV environment variable (default 'preview'); packaged builds are always 'production'.
 */

import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { resolveEnvironment } from './vault-session/effective-limit.js';

export interface EnvConfig {
  appwriteEndpoint: string;
  appwriteProjectId: string;
  websiteUrl: string;
  environment: 'preview' | 'production';
}

// Preview runs fully against localhost: the local Appwrite stack (docs/LOCAL_APPWRITE.md) and the
// website dev server (`npm run dev` in ../conduit-website) for the sign-in flow.
const PREVIEW_CONFIG: EnvConfig = {
  appwriteEndpoint: 'http://localhost:8085/v1',
  appwriteProjectId: 'conduit-dev',
  websiteUrl: 'http://localhost:3000',
  environment: 'preview',
};

const PRODUCTION_CONFIG: EnvConfig = {
  appwriteEndpoint: 'https://appwrite.cloudwise.ca/v1',
  appwriteProjectId: '6acf9d610020fad67ba9',
  websiteUrl: 'https://conduitdesktop.com',
  environment: 'production',
};

let cachedConfig: EnvConfig | null = null;

export const DEV_APPWRITE_ENDPOINT_ENV = 'CONDUIT_DEV_APPWRITE_ENDPOINT';
export const DEV_APPWRITE_PROJECT_ENV = 'CONDUIT_DEV_APPWRITE_PROJECT';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Loopback endpoint from CONDUIT_DEV_APPWRITE_ENDPOINT for dev preview builds, else null. Test runs
 * point one instance at a local proxy so it can be taken offline without stopping the shared stack.
 */
function devAppwriteEndpoint(environment: EnvConfig['environment']): string | null {
  const raw = process.env[DEV_APPWRITE_ENDPOINT_ENV]?.trim();
  if (!raw) return null;
  if (app.isPackaged || environment !== 'preview') {
    console.warn(`[env] ${DEV_APPWRITE_ENDPOINT_ENV} is ignored ${app.isPackaged ? 'in packaged builds' : 'outside preview'}`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[env] ${DEV_APPWRITE_ENDPOINT_ENV} is not a valid URL, using the preview Appwrite`);
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    console.warn(`[env] ${DEV_APPWRITE_ENDPOINT_ENV} must be an http(s) loopback URL, using the preview Appwrite`);
    return null;
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname || '/v1'}`;
}

/**
 * Get the current environment configuration.
 *
 * Packaged builds always use production and ignore CONDUIT_ENV, so a local stack cannot answer for
 * the real plan limits (spec 6.8). Dev builds honor CONDUIT_ENV and default to preview.
 */
export function getEnvConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const envVar = process.env.CONDUIT_ENV;
  if (app.isPackaged && envVar && envVar !== 'production') {
    console.warn(`[env] CONDUIT_ENV=${envVar} is ignored in packaged builds`);
  }
  const environment = resolveEnvironment(app.isPackaged, envVar);

  const base = environment === 'preview' ? PREVIEW_CONFIG : PRODUCTION_CONFIG;
  const endpointOverride = devAppwriteEndpoint(environment);
  const projectOverride = environment === 'preview' && !app.isPackaged ? process.env[DEV_APPWRITE_PROJECT_ENV]?.trim() : undefined;
  cachedConfig = {
    ...base,
    ...(endpointOverride ? { appwriteEndpoint: endpointOverride } : {}),
    ...(projectOverride ? { appwriteProjectId: projectOverride } : {}),
  };
  const dirName = cachedConfig.environment === 'production' ? 'conduit' : 'conduit-dev';
  console.log(`[env] Environment: ${cachedConfig.environment}, Data dir: ${dirName}, Appwrite: ${cachedConfig.appwriteEndpoint} (${cachedConfig.appwriteProjectId})`);
  return cachedConfig;
}

/** True for a local Appwrite stack (dev only), where the production MFA rule is not enforced. */
export function isLocalBackend(config: EnvConfig = getEnvConfig()): boolean {
  const host = new URL(config.appwriteEndpoint).hostname;
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.local');
}

// ---------- Vite dev server ----------

export const DEV_SERVER_URL_ENV = 'CONDUIT_DEV_SERVER_URL';
const DEFAULT_DEV_SERVER_URL = 'http://localhost:1420';

function devServerBase(): string {
  const raw = process.env[DEV_SERVER_URL_ENV]?.trim();
  if (!raw || app.isPackaged) return DEFAULT_DEV_SERVER_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[env] ${DEV_SERVER_URL_ENV} is not a valid URL, using the default dev server`);
    return DEFAULT_DEV_SERVER_URL;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn(`[env] ${DEV_SERVER_URL_ENV} must be http or https, using the default dev server`);
    return DEFAULT_DEV_SERVER_URL;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * URL of a page on the Vite dev server (the main window when `page` is empty). Dev builds honor
 * CONDUIT_DEV_SERVER_URL so isolated test instances can use their own server; packaged builds never load it.
 */
export function devServerUrl(page = ''): string {
  const base = devServerBase();
  return page ? `${base}/${page}` : base;
}

// ---------- Data directory & socket path ----------

function getDataDirName(): string {
  return getEnvConfig().environment === 'production' ? 'conduit' : 'conduit-dev';
}

let dataRoot: string | null = null;

/** Pin the parent of the data directories. Called by app-identity.ts before the dev rename. */
export function setDataRoot(root: string): void {
  dataRoot = root;
}

/** Path to the app's persistent data directory (env-aware). */
export function getDataDir(): string {
  return path.join(dataRoot ?? app.getPath('userData'), getDataDirName());
}

/** Check whether a path is a Windows named pipe. */
export function isNamedPipe(p: string): boolean {
  return p.startsWith('\\\\.\\pipe\\');
}

/** Path to the IPC socket (Unix socket on macOS/Linux, named pipe on Windows). */
export function getSocketPath(): string {
  const dirName = getDataDirName();

  // Windows: use named pipes (not filesystem sockets)
  if (os.platform() === 'win32') {
    return `\\\\.\\pipe\\${dirName}`;
  }

  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime) {
    return path.join(xdgRuntime, dirName, 'conduit.sock');
  }

  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', dirName, 'conduit.sock');
  }

  if (platform === 'linux') {
    return path.join(home, '.local', 'share', dirName, 'conduit.sock');
  }

  return path.join('/tmp', dirName, 'conduit.sock');
}
