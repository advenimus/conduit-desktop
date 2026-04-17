/**
 * Thin HTTP client for the Conduit backend API.
 *
 * Handles authenticated requests to the backend server for
 * fingerprint submission and other server-side operations.
 */

import type { DeviceFingerprint } from './fingerprint.js';
import { getBackendUrl, getBackendHeaders } from '../constants.js';

export interface FingerprintResponse {
  abuse_score: number;
  suspended: boolean;
}

export async function submitFingerprint(
  accessToken: string,
  fingerprint: DeviceFingerprint,
  eventType: 'login' | 'registration' | 'session_restore'
): Promise<FingerprintResponse> {
  const response = await fetch(`${getBackendUrl()}/api/fingerprint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      ...getBackendHeaders(),
    },
    body: JSON.stringify({
      ...fingerprint,
      event_type: eventType,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`Fingerprint submission failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<FingerprintResponse>;
}
