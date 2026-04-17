/**
 * Anonymous analytics for the MCP server process.
 *
 * Matches electron/services/analytics.ts — same PostHog key, same anonymous
 * distinct_id file, same opt-out semantics. Duplicated (small, ~60 lines)
 * instead of imported because the MCP server runs as an independent Node
 * process and must not depend on the Electron build.
 *
 * No-op when POSTHOG_API_KEY is unset.
 */

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { getDataDir } from './data-dir.js';

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
    anonymousId = crypto.randomUUID();
  }
  return anonymousId;
}

export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!ENABLED) return;

  const payload = {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: getAnonymousId(),
    properties: {
      source: 'mcp-server',
      platform: process.platform,
      ...properties,
    },
    timestamp: new Date().toISOString(),
  };

  fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Swallow all errors — analytics must never break tool dispatch
  });
}
