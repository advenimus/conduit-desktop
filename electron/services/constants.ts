/** Shared constants for the Electron main process. */

import { getEnvConfig } from './env-config.js';

export function getWebsiteUrl(): string {
  return getEnvConfig().websiteUrl;
}

export const SUPPORT_EMAIL = 'support@conduitdesktop.com';
