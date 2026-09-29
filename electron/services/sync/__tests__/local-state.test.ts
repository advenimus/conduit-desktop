// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCAL_JSON_VERSION,
  defaultLocalJson,
  readLocalJson,
  serializeLocalJson,
  updateLocalJson,
  validateLocalJson,
  writeLocalJson,
} from '../local-state.js';
import { TBL, type LocalJson } from '../types.js';

const LINEAGE = '0b1f6f3e-4a1c-5d7e-9f00-1234567890ab';
const INC = 'ab'.repeat(16);
const SHA = 'cd'.repeat(32);
const PID = 'ef'.repeat(16);

function full(): LocalJson {
  return {
    version: LOCAL_JSON_VERSION,
    lineageId: LINEAGE,
    binding: { sharedPath: '/Users/u/iCloud/Vault.conduit', realpath: '/Users/u/Library/Mobile Documents/Vault.conduit', fileId: '11111111-2222-4333-8444-555555555555' },
    dev: 2 ** 48 - 1,
    incarnation: INC,
    lastMergedSha256: SHA,
    lastPublished: { sha256: SHA, markerDot: { dev: 12, ms: 1700000000000, c: 3 } },
    pendingPublish: true,
    sideFiles: {
      tuples: [
        { name: 'wal', exists: true, size: 4096, mtimeMs: 1700000000123.456 },
        { name: 'shm', exists: false, size: 0, mtimeMs: 0 },
      ],
      confirmedAtMs: null,
    },
    heldLegacy: [
      {
        key: { tbl: TBL.entries, rowId: 'e1', reg: 'password' },
        kind: 'stale-revert',
        sibling: {
          dev: 0,
          ms: 1700000000000,
          c: 0,
          pid: PID,
          lt: -5,
          vhash: '01'.repeat(16),
          flags: 1,
          value: Buffer.from([0, 1, 2, 250, 251, 252]),
          prevVhash: null,
        },
        replaces: 'a:12:1699999999000:4',
        pmemAdd: { ms: 1700000000000, ids: [PID] },
        sourceSha256: SHA,
        heldAtMs: 1700000000500,
      },
      {
        key: { tbl: TBL.entries, rowId: 'e2', reg: '_life' },
        kind: 'delete',
        sibling: { dev: 0, ms: 5, c: 0, pid: PID, lt: 5, vhash: '02'.repeat(16), flags: 0, value: 'dead', prevVhash: null },
        replaces: `p:0:${'00'.repeat(16)}`,
        replacesEqual: ['a:7:1699999999001:0'],
        pmemAdd: { ms: 5, ids: ['00'.repeat(16), PID] },
        sourceSha256: SHA,
        heldAtMs: 6,
      },
    ],
    snoozed: [{ key: '03'.repeat(16), createdMs: 1 }],
    lastLimit: { value: 1, atMs: 2 },
    ignoredCopies: [SHA],
    abandonedWaits: ['wait-1'],
    notices: [
      { id: 'n1', kind: 'dropped-setting', key: { tbl: TBL.entries, rowId: 'e1', reg: 'config.content' }, createdMs: 3, sourceSha256: SHA, count: 1 },
      { id: 'n2', kind: 'mass-change', key: null, createdMs: 4, sourceSha256: null, count: 42 },
    ],
    candidateLabels: { '12345': 'Vault 2.conduit' },
    contentRepairShas: [SHA],
  };
}

function withField(path: (string | number)[], value: unknown): unknown {
  const doc = JSON.parse(serializeLocalJson(full())) as Record<string, unknown>;
  let cur: Record<string | number, unknown> = doc;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return doc;
}

describe('validateLocalJson (3.2)', () => {
  it('accepts the default document', () => {
    const d = defaultLocalJson(LINEAGE, 7, INC);
    expect(validateLocalJson(JSON.parse(serializeLocalJson(d)))).toEqual({ ok: true, value: d });
  });

  it('round-trips every field, bytes included', () => {
    const text = serializeLocalJson(full());
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('"$b64": "AAEC+vv8"');
    const res = validateLocalJson(JSON.parse(text));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual(full());
    expect(Buffer.isBuffer(res.value.heldLegacy[0].sibling.value)).toBe(true);
    expect(serializeLocalJson(res.value)).toBe(text);
  });

  it('accepts a file written before the side-file confirmation time existed, and checks it when present', () => {
    const older = Object.fromEntries(Object.entries(defaultLocalJson(LINEAGE, 7, INC)).filter(([k]) => k !== 'sideFilesConfirmedAtMs'));
    const res = validateLocalJson(JSON.parse(JSON.stringify(older)));
    expect(res.ok && res.value.sideFilesConfirmedAtMs).toBeUndefined();
    expect(validateLocalJson(withField(['sideFilesConfirmedAtMs'], 1_790_000_000_000)).ok).toBe(true);
    expect(validateLocalJson(withField(['sideFilesConfirmedAtMs'], -1)).ok).toBe(false);
  });

  it('keeps the after-publish staged-copies note of a password change (optional, boolean)', () => {
    const res = validateLocalJson(JSON.parse(JSON.stringify(defaultLocalJson(LINEAGE, 7, INC))));
    expect(res.ok && res.value.dropStagedAfterPublish).toBeUndefined();
    const set = validateLocalJson(withField(['dropStagedAfterPublish'], true));
    expect(set.ok && set.value.dropStagedAfterPublish).toBe(true);
    expect(validateLocalJson(withField(['dropStagedAfterPublish'], 'yes')).ok).toBe(false);
  });

  it('keeps the owner check of plan enforcement 3.3 (optional, validated when present)', () => {
    const older = Object.fromEntries(Object.entries(defaultLocalJson(LINEAGE, 7, INC)).filter(([k]) => k !== 'ownerCheck'));
    const res = validateLocalJson(JSON.parse(JSON.stringify(older)));
    expect(res.ok && res.value.ownerCheck).toBeUndefined();
    expect(defaultLocalJson(LINEAGE, 7, INC).ownerCheck).toBeNull();
    const check = { hint: 'ab'.repeat(16), kind: 'grace', untilMs: 1_790_000_000_000, atMs: 1_789_000_000_000 };
    const set = validateLocalJson(withField(['ownerCheck'], check));
    expect(set.ok && set.value.ownerCheck).toEqual(check);
    expect(validateLocalJson(withField(['ownerCheck'], null)).ok).toBe(true);
    expect(validateLocalJson(withField(['ownerCheck'], { ...check, kind: 'guest' })).ok).toBe(false);
    expect(validateLocalJson(withField(['ownerCheck'], { ...check, hint: 'short' })).ok).toBe(false);
  });

  it('ignores unknown keys from a newer build', () => {
    const doc = withField(['futureField'], { x: 1 });
    expect(validateLocalJson(doc).ok).toBe(true);
  });

  it.each([
    ['root not an object', [], null],
    ['wrong version', ['version'], 2],
    ['bad lineage', ['lineageId'], 'not-a-uuid'],
    ['dev zero', ['dev'], 0],
    ['dev negative', ['dev'], -3],
    ['dev beyond 48 bits', ['dev'], 2 ** 48],
    ['dev fractional', ['dev'], 1.5],
    ['short incarnation', ['incarnation'], 'ab'],
    ['uppercase incarnation', ['incarnation'], 'AB'.repeat(16)],
    ['short sha', ['lastMergedSha256'], 'cd'.repeat(16)],
    ['marker dot dev 0', ['lastPublished', 'markerDot', 'dev'], 0],
    ['marker counter overflow', ['lastPublished', 'markerDot', 'c'], 65536],
    ['pendingPublish not boolean', ['pendingPublish'], 1],
    ['side file name', ['sideFiles', 'tuples', 0, 'name'], 'journal'],
    ['unknown notice kind', ['notices', 1, 'kind'], 'surprise'],
    ['notice count negative', ['notices', 1, 'count'], -1],
    ['bad table', ['heldLegacy', 0, 'key', 'tbl'], 5],
    ['empty row id', ['heldLegacy', 0, 'key', 'rowId'], ''],
    ['held kind', ['heldLegacy', 0, 'kind'], 'edit'],
    ['pseudo sibling without pid', ['heldLegacy', 0, 'sibling', 'pid'], ''],
    ['pseudo sibling with c', ['heldLegacy', 0, 'sibling', 'c'], 1],
    ['bad vhash', ['heldLegacy', 0, 'sibling', 'vhash'], 'zz'.repeat(16)],
    ['bad prev', ['heldLegacy', 0, 'sibling', 'prevVhash'], 'ab'],
    ['flags out of range', ['heldLegacy', 0, 'sibling', 'flags'], 4],
    ['non-canonical base64', ['heldLegacy', 0, 'sibling', 'value'], { $b64: 'AAEC+vv8=' }],
    ['value object', ['heldLegacy', 0, 'sibling', 'value'], { x: 1 }],
    ['missing value', ['heldLegacy', 0, 'sibling', 'value'], undefined],
    ['bad replaces', ['heldLegacy', 0, 'replaces'], 'a:0:1:2'],
    ['bad replacesEqual', ['heldLegacy', 1, 'replacesEqual'], ['a:0:1:2']],
    ['replacesEqual not an array', ['heldLegacy', 1, 'replacesEqual'], 'a:7:1:0'],
    ['replacesEqual null', ['heldLegacy', 1, 'replacesEqual'], null],
    ['unsorted pmem ids', ['heldLegacy', 1, 'pmemAdd', 'ids'], [PID, '00'.repeat(16)]],
    ['empty pmem ids', ['heldLegacy', 1, 'pmemAdd', 'ids'], []],
    ['bad snooze key', ['snoozed', 0, 'key'], 'k'],
    ['bad ignored copy', ['ignoredCopies', 0], 'x'],
    ['candidate label key 0', ['candidateLabels'], { '0': 'x' }],
    ['candidate label key text', ['candidateLabels'], { dev: 'x' }],
    ['candidate label value', ['candidateLabels'], { '5': 5 }],
    ['binding file id', ['binding', 'fileId'], 'f'],
    ['missing notices', ['notices'], undefined],
  ] as [string, (string | number)[], unknown][])('rejects %s', (_label, at, value) => {
    const doc = at.length === 0 ? value : withField(at, value);
    const res = validateLocalJson(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.length).toBeGreaterThan(0);
  });

  it('reports every error with its path', () => {
    const doc = withField(['dev'], 0) as Record<string, unknown>;
    doc.incarnation = 'x';
    const res = validateLocalJson(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toEqual(expect.arrayContaining([expect.stringMatching(/^\$\.dev: /), expect.stringMatching(/^\$\.incarnation: /)]));
    }
  });
});

describe('local.json on disk', () => {
  let dir: string;
  const NOW = 1700000000000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-sync-local-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const file = (): string => path.join(dir, 'local.json');

  it('reads nothing when the file is missing', () => {
    expect(readLocalJson(dir, NOW)).toEqual({ value: null, parkedTo: null, errors: [] });
  });

  it('writes atomically and reads back', () => {
    writeLocalJson(dir, full());
    expect(fs.readdirSync(dir)).toEqual(['local.json']);
    expect(fs.readFileSync(file(), 'utf8')).toBe(serializeLocalJson(full()));
    expect(readLocalJson(dir, NOW)).toEqual({ value: full(), parkedTo: null, errors: [] });
  });

  it('refuses to write an invalid document and keeps the old file', () => {
    writeLocalJson(dir, full());
    const bad = { ...full(), dev: 0 };
    expect(() => writeLocalJson(dir, bad)).toThrow(/invalid local.json/);
    expect(readLocalJson(dir, NOW).value).toEqual(full());
  });

  it('parks a file that is not JSON', () => {
    fs.writeFileSync(file(), '{"version": 1,');
    const res = readLocalJson(dir, NOW);
    expect(res.value).toBeNull();
    expect(res.parkedTo).toBe(path.join(dir, 'parked', `local-${NOW}.json`));
    expect(res.errors).toEqual(['$: not valid JSON']);
    expect(fs.existsSync(file())).toBe(false);
    expect(fs.readFileSync(res.parkedTo!, 'utf8')).toBe('{"version": 1,');
  });

  it('parks a schema-invalid file under a free name', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1 }));
    const first = readLocalJson(dir, NOW);
    fs.writeFileSync(file(), JSON.stringify({ version: 9 }));
    const second = readLocalJson(dir, NOW);
    expect(first.parkedTo).toBe(path.join(dir, 'parked', `local-${NOW}.json`));
    expect(second.parkedTo).toBe(path.join(dir, 'parked', `local-${NOW}-1.json`));
    expect(second.errors.some((e) => e.startsWith('$.version'))).toBe(true);
  });

  it('updates from the fallback when missing and from the file otherwise', () => {
    const fallback = defaultLocalJson(LINEAGE, 7, INC);
    const a = updateLocalJson(dir, fallback, (cur) => ({ ...cur, pendingPublish: true }), NOW);
    expect(a.pendingPublish).toBe(true);
    const b = updateLocalJson(dir, fallback, (cur) => ({ ...cur, notices: [...cur.notices, { id: 'n', kind: 'invariant-repair', key: null, createdMs: 1, sourceSha256: null, count: 1 }] }), NOW);
    expect(b.pendingPublish).toBe(true);
    expect(b.notices).toHaveLength(1);
    expect(readLocalJson(dir, NOW).value).toEqual(b);
  });

  it('skips the write when nothing changed', () => {
    const compact = JSON.stringify(JSON.parse(serializeLocalJson(full())));
    fs.writeFileSync(file(), compact);
    const out = updateLocalJson(dir, defaultLocalJson(LINEAGE, 7, INC), (cur) => cur, NOW);
    expect(out).toEqual(full());
    expect(fs.readFileSync(file(), 'utf8')).toBe(compact);
  });

  it('rebuilds from the fallback after parking a corrupt file', () => {
    fs.writeFileSync(file(), 'garbage');
    const fallback = defaultLocalJson(LINEAGE, 9, INC);
    const out = updateLocalJson(dir, fallback, (cur) => cur, NOW);
    expect(out).toBe(fallback);
    expect(readLocalJson(dir, NOW).value).toEqual(fallback);
    expect(fs.readdirSync(path.join(dir, 'parked'))).toEqual([`local-${NOW}.json`]);
  });
});
