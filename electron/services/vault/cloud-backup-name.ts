/**
 * File names of versioned cloud backup snapshots (`<user>/<vault>/backups/`). Readers only rely on
 * the `.enc` suffix (listing) and the storage object's created_at (order, pruning, display), so the
 * name only has to be unique: two uploads in the same second must not collide.
 */

import crypto from 'node:crypto';

const PREFIX = 'vault_';
const SUFFIX = '.enc';
const RANDOM_BYTES = 3;

/** `vault_2026-09-26_14-03-07-412_a1b2c3.enc`: UTC time to the millisecond plus a random tag. */
export function snapshotFileName(now: Date, randomHex: string = crypto.randomBytes(RANDOM_BYTES).toString('hex')): string {
  const ts = now.toISOString().replace('T', '_').replace('Z', '').replace(/[:.]/g, '-');
  return `${PREFIX}${ts}_${randomHex}${SUFFIX}`;
}
