// @vitest-environment node
// presence.ts (spec 3.5, 6.2, 6.7, 12 row 70): value building, strict parsing, the provisional
// presence of each device, the activity window with future times ignored, and a presence write
// through the real replica (one app sibling, no rule R re-assertions).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { presenceWrite } from '../capture-local.js';
import { deviceRegKey } from '../catalog.js';
import { vhashOfValue } from '../hashing.js';
import { jcs } from '../jcs.js';
import {
  CLAIM_ACTIVITY_WINDOW_MS,
  PRESENCE_FUTURE_TOLERANCE_MS,
  buildPresence,
  isRecentlyActive,
  listPresence,
  parsePresence,
  readPresence,
  samePresenceIgnoringActivity,
  type PresenceFields,
} from '../presence.js';
import { getRegister } from '../state-view.js';
import type { PresenceValue, SyncState } from '../types.js';
import { makeTempRoot } from './host-fakes.js';
import { DEVICE_A, E1_FIXTURE, stateWithPresence } from './presence-fixtures.js';
import { bindingFor, makeDevice, newVaultSeed, open } from './replica-fixtures.js';

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FIELDS: PresenceFields = {
  device: { name: 'MacBook', platform: 'macos', appVersion: '0.18.0' },
  nowMs: 10_000,
  sessionOpen: true,
  sessionSinceMs: 9_000,
  accountHint: 'hint',
  fileHint: { file_id: 'f1', location: 'icloud:Vaults', file_name: 'Vault.conduit' },
  sideFilesSeenMs: null,
};

function value(over: Partial<PresenceValue> = {}): PresenceValue {
  return { ...buildPresence(null, FIELDS), ...over };
}

describe('buildPresence and parsePresence', () => {
  it('round-trips through JCS text and keeps first_seen_ms from the previous value', () => {
    const first = buildPresence(null, FIELDS);
    expect(first).toMatchObject({ first_seen_ms: 10_000, last_active_ms: 10_000, session_open: 1, session_since_ms: 9_000 });
    const later = buildPresence(first, { ...FIELDS, nowMs: 20_000, sessionOpen: false, sessionSinceMs: null });
    expect(later).toMatchObject({ first_seen_ms: 10_000, last_active_ms: 20_000, session_open: 0, session_since_ms: null });
    expect(parsePresence(jcs(later))).toEqual(later);
  });

  it('rejects text that is not a presence object', () => {
    const good = value();
    expect(parsePresence('not json')).toBeNull();
    expect(parsePresence('[]')).toBeNull();
    expect(parsePresence(JSON.stringify({ ...good, session_open: 2 }))).toBeNull();
    expect(parsePresence(JSON.stringify({ ...good, last_active_ms: '5' }))).toBeNull();
    expect(parsePresence(JSON.stringify({ ...good, file_hint: { file_id: 'x' } }))).toBeNull();
    const noName: Record<string, unknown> = { ...good };
    delete noName.name;
    expect(parsePresence(JSON.stringify(noName))).toBeNull();
    expect(parsePresence(JSON.stringify({ ...good, file_hint: null }))).toMatchObject({ file_hint: null });
  });

  it('compares every field except the activity time', () => {
    const a = value();
    expect(samePresenceIgnoringActivity(a, { ...a, last_active_ms: 99_999 })).toBe(true);
    expect(samePresenceIgnoringActivity(a, { ...a, file_hint: { ...a.file_hint!, file_id: 'f2' } })).toBe(false);
    expect(samePresenceIgnoringActivity(a, { ...a, session_open: 0 })).toBe(false);
  });
});

describe('isRecentlyActive (6.7, 12 row 70)', () => {
  const now = 1_000_000_000;

  it('needs an open session within the window', () => {
    expect(isRecentlyActive(value({ last_active_ms: now - CLAIM_ACTIVITY_WINDOW_MS }), now)).toBe(true);
    expect(isRecentlyActive(value({ last_active_ms: now - CLAIM_ACTIVITY_WINDOW_MS - 1 }), now)).toBe(false);
    expect(isRecentlyActive(value({ last_active_ms: now, session_open: 0 }), now)).toBe(false);
  });

  it('ignores activity dated more than 5 minutes in the future', () => {
    expect(isRecentlyActive(value({ last_active_ms: now + PRESENCE_FUTURE_TOLERANCE_MS }), now)).toBe(true);
    expect(isRecentlyActive(value({ last_active_ms: now + PRESENCE_FUTURE_TOLERANCE_MS + 1 }), now)).toBe(false);
    expect(isRecentlyActive(value({ last_active_ms: now + 30 * 24 * 60 * 60 * 1000 }), now)).toBe(false);
  });
});

describe('readPresence and listPresence', () => {
  it('reads the provisional value of each device register, sorted by device uuid, skipping bad ones', () => {
    const b = 'bbbbbbbb-0000-4000-8000-000000000002';
    const a = 'aaaaaaaa-0000-4000-8000-000000000001';
    const c = 'cccccccc-0000-4000-8000-000000000003';
    let s: SyncState = stateWithPresence(E1_FIXTURE, b, jcs(value({ name: 'B' })), { dev: 11, ms: 500 });
    s = stateWithPresence(s, a, jcs(value({ name: 'A' })), { dev: 12, ms: 600 });
    s = stateWithPresence(s, c, 'garbage', { dev: 13, ms: 700 });
    expect(listPresence(s).map((p) => [p.deviceUuid, p.value.name])).toEqual([
      [a, 'A'],
      [b, 'B'],
    ]);
    expect(readPresence(s, b)?.dot).toEqual({ dev: 11, ms: 500, c: 0 });
    expect(readPresence(s, c)).toBeNull();
    expect(readPresence(s, DEVICE_A)).toBeNull();
  });

  it('gives a null dot for a pseudo (legacy) presence sibling', () => {
    const uuid = 'dddddddd-0000-4000-8000-000000000004';
    const s = stateWithPresence(E1_FIXTURE, uuid, jcs(value()), { dev: 0, ms: 800 });
    expect(readPresence(s, uuid)).toMatchObject({ deviceUuid: uuid, dot: null });
  });

  it('a presence write through the replica is one interactive app sibling without rule R', async () => {
    const root = makeTempRoot('presence');
    roots.push(root);
    const d = makeDevice(root);
    const nv = newVaultSeed(d);
    const { replica } = await open(d, nv.lineageId, nv.key, nv.seed, bindingFor(path.join(root, 'Vault.conduit')));
    try {
      const p = buildPresence(null, FIELDS);
      const before = replica.state().rows.size;
      replica.applyWrites([presenceWrite(p, replica.context())], { interactive: true, ruleR: false });
      const reg = getRegister(replica.state(), deviceRegKey(replica.deviceUuid));
      expect(reg?.sibs).toHaveLength(1);
      expect(reg?.sibs[0]).toMatchObject({ dev: replica.dev(), value: jcs(p), vhash: vhashOfValue(deviceRegKey(replica.deviceUuid), jcs(p)) });
      expect(replica.state().rows.size).toBe(before + 1);
      expect(readPresence(replica.state(), replica.deviceUuid)?.value).toEqual(p);
    } finally {
      replica.close();
    }
  });
});
