// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownerTagWrite } from '../../sync/capture-local.js';
import { ownerTagRegKey } from '../../sync/catalog.js';
import { evaluateOwnerTag, ownerHint, ownerTagWritesFor, readOwnerTag, releasedTagWrites } from '../owner-tag.js';
import { OWNER_TAG_MODULE, ownerTagFile, type OwnerTagRow } from './owner-tag-vectors.js';
import { contextFor, stateWithOwnerTag } from './owner-tag-fixtures.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sync', '__vectors__', `${OWNER_TAG_MODULE}.json`);
const UPDATE = process.env.SYNC_UPDATE_VECTORS === '1';

function serialize(file: object): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

describe('owner-tag.json (plan enforcement 3.4)', () => {
  const text = serialize(ownerTagFile());

  it('matches a fresh build byte for byte', () => {
    if (UPDATE) fs.writeFileSync(VECTORS, text);
    expect(fs.readFileSync(VECTORS, 'utf8')).toBe(text);
  });

  it('has at least 18 rows with unique names', () => {
    const rows = (JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as { rows: OwnerTagRow[] }).rows;
    expect(rows.length).toBeGreaterThanOrEqual(18);
    expect(new Set(rows.map((r) => r.name)).size).toBe(rows.length);
  });

  it('evaluateOwnerTag gives every row its expected verdict', () => {
    const rows = (JSON.parse(fs.readFileSync(VECTORS, 'utf8')) as { rows: OwnerTagRow[] }).rows;
    for (const r of rows) {
      const tag = r.tag === null ? null : { a: r.tag.a, ms: r.tagMs };
      const got = evaluateOwnerTag({ signedIn: r.signedIn, peekConfirmed: r.peekConfirmed, userId: r.userId, lineageId: r.lineageId, tag, ownerCheck: r.ownerCheck, nowMs: r.nowMs });
      expect({ name: r.name, verdict: got }).toEqual({ name: r.name, verdict: r.expect });
    }
  });
});

describe('readOwnerTag', () => {
  const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
  const HINT = ownerHint(LINEAGE, 'ABC-user');

  it('is null without the register and reads the provisional value with its ms', () => {
    expect(readOwnerTag(stateWithOwnerTag(LINEAGE, []))).toBeNull();
    const s = stateWithOwnerTag(LINEAGE, [{ value: JSON.stringify({ a: HINT }), ms: 5_000 }]);
    expect(readOwnerTag(s)).toEqual({ a: HINT, ms: 5_000 });
    expect(readOwnerTag(stateWithOwnerTag(LINEAGE, [{ value: '{"a":null}', ms: 7 }]))).toEqual({ a: null, ms: 7 });
  });

  it('ignores a value that is not null or 32 lowercase hex', () => {
    for (const value of ['{"a":"ABCDEF0123456789ABCDEF0123456789"}', '{"a":"short"}', '{"a":1}', '[]', '{}']) {
      expect(readOwnerTag(stateWithOwnerTag(LINEAGE, [{ value, ms: 1 }]))).toBeNull();
    }
  });

  it('hashes the lowercase user id', () => {
    expect(ownerHint(LINEAGE, 'ABC-user')).toBe(ownerHint(LINEAGE, 'abc-user'));
  });
});

describe('owner tag writes (3.2)', () => {
  const LINEAGE = '0b8f3d52-6c41-4f0e-9d7e-1c2a3b4c5d6e';
  const HINT = ownerHint(LINEAGE, 'user-1');
  const OWNER = { kind: 'owner', releaseAfterMs: null, sharedUntilMs: null } as const;

  it('writes only for a confirmed owner whose hint differs from the tag', () => {
    const empty = stateWithOwnerTag(LINEAGE, []);
    const ctx = contextFor(empty);
    const writes = ownerTagWritesFor(OWNER, HINT, empty, ctx);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toEqual(ownerTagRegKey());
    expect(writes[0]).toEqual(ownerTagWrite({ a: HINT }, ctx));
    const same = stateWithOwnerTag(LINEAGE, [{ value: JSON.stringify({ a: HINT }), ms: 1 }]);
    expect(ownerTagWritesFor(OWNER, HINT, same, contextFor(same))).toEqual([]);
  });

  it('never writes for grace, unowned, unknown or a signed-out device', () => {
    const empty = stateWithOwnerTag(LINEAGE, []);
    const ctx = contextFor(empty);
    expect(ownerTagWritesFor({ kind: 'grace', untilMs: 1 }, HINT, empty, ctx)).toEqual([]);
    expect(ownerTagWritesFor({ kind: 'unowned' }, HINT, empty, ctx)).toEqual([]);
    expect(ownerTagWritesFor(null, HINT, empty, ctx)).toEqual([]);
    expect(ownerTagWritesFor(OWNER, null, empty, ctx)).toEqual([]);
  });

  it('writes {"a": null} after a release unless the tag is already null', () => {
    const tagged = stateWithOwnerTag(LINEAGE, [{ value: JSON.stringify({ a: HINT }), ms: 1 }]);
    expect(releasedTagWrites(tagged, contextFor(tagged))).toEqual([ownerTagWrite({ a: null }, contextFor(tagged))]);
    const released = stateWithOwnerTag(LINEAGE, [{ value: '{"a":null}', ms: 1 }]);
    expect(releasedTagWrites(released, contextFor(released))).toEqual([]);
  });
});
