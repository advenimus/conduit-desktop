/**
 * Anonymous analytics for Conduit desktop.
 *
 * Sends events to PostHog when POSTHOG_API_KEY is set. No-op otherwise,
 * which makes local dev and self-built installs stay silent.
 *
 * Privacy:
 * - Anonymous by default (random UUID per install, stored in userData)
 * - No PII (no email, no hostnames, no credential names)
 * - User can opt out via Settings → Privacy (future UI); honored via
 *   `analytics_opt_out` in settings.json
 * - Never sends on first launch if opt-out is set
 *
 * Rationale for adding this in WS6: we cannot diagnose the conversion
 * funnel (install → first connection → MCP call → subscribe) without
 * minimal telemetry. See docs/campaigns/... for the research that drove
 * this decision.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { app } from 'electron';
import { getDataDir } from './env-config.js';
import { readSettings } from '../ipc/settings.js';

const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';
const POSTHOG_KEY = process.env.POSTHOG_API_KEY ?? '';
const ENABLED = POSTHOG_KEY.length > 0;

let anonymousId: string | null = null;

function getAnonymousId(): string {
  if (anonymousId) return anonymousId;
  try {
    const filePath = path.join(getDataDir(), 'analytics-id');
    if (fs.existsSync(filePath)) {
      anonymousId = fs.readFileSync(filePath, 'utf-8').trim();
    }
    if (!anonymousId) {
      anonymousId = crypto.randomUUID();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, anonymousId, 'utf-8');
    }
  } catch {
    // Fall back to in-memory UUID if filesystem access fails
    anonymousId = crypto.randomUUID();
  }
  return anonymousId;
}

function isOptedOut(): boolean {
  try {
    const settings = readSettings() as { analytics_opt_out?: boolean };
    return !!settings.analytics_opt_out;
  } catch {
    return false;
  }
}

interface PostHogEvent {
  api_key: string;
  event: string;
  properties: Record<string, unknown>;
  distinct_id: string;
  timestamp: string;
}

/**
 * Fire an event. Never throws; never blocks. Safe to call on startup.
 * Returns immediately (fire-and-forget via async fetch).
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!ENABLED) return;
  if (isOptedOut()) return;

  const payload: PostHogEvent = {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: getAnonymousId(),
    properties: {
      app_version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      ...properties,
    },
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget fetch. Never await this call from the caller.
  fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Swallow all errors — analytics must never break the app
  });
}

export function isAnalyticsEnabled(): boolean {
  return ENABLED && !isOptedOut();
}
