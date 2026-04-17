/** Shared constants for the Electron main process. */

import { getEnvConfig } from './env-config.js';

export function getBackendUrl(): string {
  return getEnvConfig().backendUrl;
}

/** Extra headers required for backend requests (e.g. Vercel deployment protection bypass). */
export function getBackendHeaders(): Record<string, string> {
  const key = getEnvConfig().vercelBypassKey;
  return key ? { 'x-vercel-protection-bypass': key } : {};
}

export function getWebsiteUrl(): string {
  return getEnvConfig().websiteUrl;
}

export const SUPPORT_EMAIL = 'support@conduitdesktop.com';
