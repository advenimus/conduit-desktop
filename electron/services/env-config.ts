/**
 * Environment configuration for the Electron main process.
 *
 * Resolves Supabase, website, and backend URLs based on the CONDUIT_ENV
 * environment variable. Defaults to 'preview' in dev, 'production' when packaged.
 */

import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';

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

/**
 * Get the current environment configuration.
 *
 * Resolution order:
 * 1. CONDUIT_ENV env var ('preview' or 'production')
 * 2. Fallback: packaged app → 'production', dev → 'preview'
 */
export function getEnvConfig(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  const envVar = process.env.CONDUIT_ENV;
  let environment: 'preview' | 'production';

  if (envVar === 'preview' || envVar === 'production') {
    environment = envVar;
  } else {
    environment = app.isPackaged ? 'production' : 'preview';
  }

  cachedConfig = environment === 'preview' ? PREVIEW_CONFIG : PRODUCTION_CONFIG;
  const dirName = cachedConfig.environment === 'production' ? 'conduit' : 'conduit-dev';
  console.log(`[env] Environment: ${cachedConfig.environment}, Data dir: ${dirName}, Supabase: ${cachedConfig.supabaseUrl}`);
  return cachedConfig;
}

// ---------- Data directory & socket path ----------

function getDataDirName(): string {
  return getEnvConfig().environment === 'production' ? 'conduit' : 'conduit-dev';
}

/** Path to the app's persistent data directory (env-aware). */
export function getDataDir(): string {
  return path.join(app.getPath('userData'), getDataDirName());
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
