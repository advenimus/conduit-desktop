/**
 * Environment configuration for the Electron main process.
 *
 * Resolves Supabase, website, and backend URLs. Dev builds follow the CONDUIT_ENV
 * environment variable (default 'preview'); packaged builds are always 'production'.
 */

import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { resolveEnvironment } from './vault-session/effective-limit.js';

export interface EnvConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  websiteUrl: string;
  backendUrl: string;
  environment: 'preview' | 'production';
  /** Vercel deployment protection bypass key (preview only). */
  vercelBypassKey?: string;
}

// Preview runs fully against localhost (WS3). Start the stack with:
//   `supabase start`  (from the conduit repo root) — local Postgres/Auth
//   `npm run dev`     (in ../conduit-website) — local website for sign-in flow
//   `npm run dev`     (in ../conduit-backend) — optional, only for chat sync / fingerprint
// See docs/LOCAL_SUPABASE.md for full setup.
//
// The anon key below is the well-known local development key — not a secret,
// safe to commit. Rotates only if `supabase start` is rerun with new keys.
const PREVIEW_CONFIG: EnvConfig = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  websiteUrl: 'http://localhost:3000',
  backendUrl: 'http://localhost:3001',
  environment: 'preview',
};

const PRODUCTION_CONFIG: EnvConfig = {
  supabaseUrl: 'https://khuyzxadaszwxirwykms.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtodXl6eGFkYXN6d3hpcnd5a21zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4Mjc4MjksImV4cCI6MjA4NjQwMzgyOX0.haS0tgktlHkiiG_tTHvw9orxOc-_Bb-GXwJLoAIWtcg',
  websiteUrl: 'https://conduitdesktop.com',
  backendUrl: 'https://conduit-backend.vercel.app',
  environment: 'production',
};

let cachedConfig: EnvConfig | null = null;

export const DEV_SUPABASE_URL_ENV = 'CONDUIT_DEV_SUPABASE_URL';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Loopback origin from CONDUIT_DEV_SUPABASE_URL for dev preview builds, else null. Test runs point
 * one instance at a local proxy so it can be taken offline without stopping the shared stack.
 */
function devSupabaseUrl(environment: EnvConfig['environment']): string | null {
  const raw = process.env[DEV_SUPABASE_URL_ENV]?.trim();
  if (!raw) return null;
  if (app.isPackaged || environment !== 'preview') {
    console.warn(`[env] ${DEV_SUPABASE_URL_ENV} is ignored ${app.isPackaged ? 'in packaged builds' : 'outside preview'}`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[env] ${DEV_SUPABASE_URL_ENV} is not a valid URL, using the preview Supabase`);
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    console.warn(`[env] ${DEV_SUPABASE_URL_ENV} must be an http(s) loopback URL, using the preview Supabase`);
    return null;
  }
  return parsed.origin;
}

/**
 * Get the current environment configuration.
 *
 * Packaged builds always use production and ignore CONDUIT_ENV, so a local Supabase cannot
 * answer for the real plan limits (spec 6.8). Dev builds honor CONDUIT_ENV and default to preview.
 */
export function getEnvConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const envVar = process.env.CONDUIT_ENV;
  if (app.isPackaged && envVar && envVar !== 'production') {
    console.warn(`[env] CONDUIT_ENV=${envVar} is ignored in packaged builds`);
  }
  const environment = resolveEnvironment(app.isPackaged, envVar);

  const base = environment === 'preview' ? PREVIEW_CONFIG : PRODUCTION_CONFIG;
  const supabaseOverride = devSupabaseUrl(environment);
  cachedConfig = supabaseOverride ? { ...base, supabaseUrl: supabaseOverride } : base;
  const dirName = cachedConfig.environment === 'production' ? 'conduit' : 'conduit-dev';
  console.log(`[env] Environment: ${cachedConfig.environment}, Data dir: ${dirName}, Supabase: ${cachedConfig.supabaseUrl}`);
  return cachedConfig;
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
