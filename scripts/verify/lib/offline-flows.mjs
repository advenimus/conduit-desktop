// Offline and lease helpers (spec 6.8): the session badge, device limit and soft lock from
// sync_get_state and Settings > Sync, lease rows per device, the owner claim in a vault file, and a
// cloud drive's delivery of one device's file to another device's folder (each device then has its
// own local copy, as with a real drive).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { leaseRows } from './supabase.mjs';
import { withPrivateCopy } from './sync-files.mjs';
import { cancelSettings, readSyncTab } from './settings-flows.mjs';
import { readSyncState, waitFor } from './ui.mjs';

export const OFFLINE_BADGE = 'offline-device-check';
export const OFFLINE_TEXT = 'Offline: device check paused';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * {badge, kind, limit, source, lineageId, softLocked} of the personal vault (nulls when no engine
 * runs). `badge` is status.sessionBadge; `limit` and `source` are the effective device limit (6.8).
 */
export async function sessionFacts(device) {
  const s = await readSyncState(device);
  return {
    badge: s.status?.sessionBadge ?? null,
    kind: s.status?.kind ?? null,
    limit: s.deviceLimit?.limit ?? null,
    source: s.deviceLimit?.source ?? null,
    lineageId: s.vault?.lineageId ?? null,
    softLocked: s.softLocked === true,
  };
}

/** Polls sessionFacts until `pred(facts)` holds; returns the facts. */
export function waitSessionFacts(device, pred, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'session facts' } = {}) {
  return waitFor(async () => {
    const facts = await sessionFacts(device);
    if (pred(facts)) return facts;
    throw new Error(`facts ${JSON.stringify(facts)}`);
  }, { timeoutMs, intervalMs: 500, label: `${device.name}: ${label}` });
}

/**
 * Settings > Sync: the status box's detail line ("Offline: device check paused" while the lease is
 * unconfirmed) and the plan line, then Cancel. The sidebar indicator shows the same detail as its
 * tooltip, but test windows start with the sidebar collapsed.
 */
export async function syncTabStatus(device) {
  const tab = await readSyncTab(device);
  await cancelSettings(device);
  return { status: tab.status, detail: tab.detail, plan: tab.plan };
}

/** personal_vault_sessions rows of `email` for one device (device.json uuid). */
export async function leaseRowsOf(email, deviceId) {
  return (await leaseRows(email)).filter((r) => r.device_id === deviceId);
}

const UUID = /"d"\s*:\s*"([0-9a-f-]{36})"/i;

function compareSiblings(x, y) {
  return x.hlc_ms - y.hlc_ms || x.hlc_c - y.hlc_c || x.dev - y.dev || x.lt - y.lt || Buffer.compare(x.pid ?? Buffer.alloc(0), y.pid ?? Buffer.alloc(0));
}

/**
 * device_uuid of the provisional owner claim (_sync/owner/owner, spec 6.7) in a vault file, read
 * through a private copy; null when the file has no claim. Rank as in sibling.ts compareRank.
 */
export function ownerClaimOf(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => {
    const sibs = db.prepare(
      `select s.value, s.hlc_ms, s.hlc_c, s.dev, s.lt, s.pid from sync_sibling s join sync_rowkey k on k.rid = s.rid
        where k.row_id = 'owner' and s.reg = 'owner'`,
    ).all();
    const top = sibs.sort(compareSiblings).pop();
    if (!top) return null;
    const match = UUID.exec(Buffer.isBuffer(top.value) ? top.value.toString('utf8') : String(top.value));
    if (!match) throw new Error(`Unreadable owner claim in ${path.basename(file)}: ${String(top.value).slice(0, 120)}`);
    return match[1].toLowerCase();
  });
}

/**
 * A cloud drive delivering `from` to `to` on another device: the bytes (plain read, no SQLite
 * open) land under a temp name without the .conduit extension, then are renamed into place.
 */
export function deliverFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = path.join(path.dirname(to), `.cv-drive-${crypto.randomBytes(4).toString('hex')}.part`);
  fs.writeFileSync(tmp, fs.readFileSync(from));
  fs.renameSync(tmp, to);
  return to;
}
