/**
 * Fixed inputs of the golden vectors (spec 13.1). Outputs are computed by golden-run.ts and
 * written to __vectors__/<module>.json; golden-vectors.test.ts asserts the files are byte-equal
 * to a fresh build. Changing an input or an algorithm changes the files: regenerate with
 * SYNC_UPDATE_VECTORS=1 and ship the Swift port update in the same release. Hashing inputs: golden-inputs-hashing.ts.
 */

import { FUTURE_CAP_MS, HLC_MAX_COUNTER } from '../types.js';
import type { CaseInput, EncodedValue } from './golden-run.js';

export const E = 1;
export const F = 2;
export const H = 3;
export const M = 4;
export const S = 9;
export const WALL = 1_759_000_000_000;

export const ASCII_NOTE = 'The file is pure ASCII: \\uXXXX escapes in strings stand for the decoded characters, which are what the functions see.';

export const kv = (tbl: number, rowId: string, reg: string, value: EncodedValue): CaseInput['input'] => ({ tbl, rowId, reg, value });
export const named = (fn: string, name: string, input: CaseInput['input']): CaseInput => ({ name: `${fn}: ${name}`, fn, input });

// ---------- canon.json ----------

export const CANON_NOTES: readonly string[] = [
  'canon(v) of spec 3.6. Outputs are lowercase hex of the canon bytes.',
  ASCII_NOTE,
  'Values: null, JSON number, JSON string, or {"hex": ...} for bytes (UTF-8 decoded for text kinds).',
  'jcs: input JSON text, output its RFC 8785 JCS text; null means the text is rejected (invalid JSON or a number with no JSON form, such as 1E400). canon of such a JSON register falls back to the raw text.',
  'jcsNumber: input IEEE-754 double bits (big-endian hex), output the JCS number text (RFC 8785 appendix B); null = must be rejected (NaN, Infinity).',
  'parseTimestamp: ISO 8601 YYYY-MM-DDTHH:MM(:SS(.f+)?)?(Z|+HH:MM|-HH:MM)? (no zone = UTC), GRDB YYYY-MM-DD HH:MM(:SS(.f+)?)? (UTC), or YYYY-MM-DD. Fraction truncated to ms. Field out of range, or instant outside years 0000..9999 UTC, gives null.',
  'parseLegacyTime: parseTimestamp of the text form; missing, unparseable or before 1970 gives 0.',
];

function canonCases(): CaseInput[] {
  const c = (name: string, tbl: number, rowId: string, reg: string, value: EncodedValue): CaseInput =>
    named('canon', name, kv(tbl, rowId, reg, value));
  return [
    c('_life live', E, 'e1', '_life', 'live'),
    c('_life dead', E, 'e1', '_life', 'dead'),
    c('name text', E, 'e1', 'name', 'Prod database'),
    c('name empty string is a real value', E, 'e1', 'name', ''),
    c('name null', E, 'e1', 'name', null),
    c('name precomposed e-acute', E, 'e1', 'name', 'café'),
    c('name decomposed e-acute (no normalization)', E, 'e1', 'name', 'café'),
    c('name astral emoji', E, 'e1', 'name', '🔑 key'),
    c('entry_type', E, 'e1', 'entry_type', 'ssh'),
    c('host text', E, 'e1', 'host', 'db.example.com'),
    c('host empty string equals null', E, 'e1', 'host', ''),
    c('host null', E, 'e1', 'host', null),
    c('host bytes decode as UTF-8', E, 'e1', 'host', { hex: '68c3a9' }),
    c('port integer', E, 'e1', 'port', 22),
    c('port integer text', E, 'e1', 'port', '22'),
    c('port padded integer text', E, 'e1', 'port', ' 22 '),
    c('port negative', E, 'e1', 'port', -1),
    c('port non-numeric legacy text', E, 'e1', 'port', 'ssh'),
    c('port blank text', E, 'e1', 'port', ''),
    c('port null', E, 'e1', 'port', null),
    c('sort_order null is 0', E, 'e1', 'sort_order', null),
    c('sort_order text', E, 'e1', 'sort_order', '7'),
    c('is_favorite 1', E, 'e1', 'is_favorite', 1),
    c('is_favorite 0', E, 'e1', 'is_favorite', 0),
    c('tag present', E, 'e1', 'tag:prod', 1),
    c('tag absent', E, 'e1', 'tag:prod', null),
    c('config re-canonicalized', E, 'e1', 'config.rdp', '{ "b": [1, 2.50, 1e2], "a": "x" }'),
    c('config JSON null is not absent', E, 'e1', 'config.rdp', 'null'),
    c('config absent', E, 'e1', 'config.rdp', null),
    c('config empty array', E, 'e1', 'config.sharedFolders', '[]'),
    c('config empty object', E, 'e1', 'config.rdp', '{}'),
    c('config empty string', E, 'e1', 'config.content', '""'),
    c('config key order by UTF-16 code units', E, 'e1', 'config.k', '{"\\ufb33":4,"\\ud83d\\ude00":3,"\\u20ac":1,"\\r":2}'),
    c('config invalid JSON keeps raw text', E, 'e1', 'config.rdp', '{broken'),
    c('config number overflow keeps raw text', E, 'e1', 'config.rdp', '1E400'),
    c('container root', E, 'e1', 'container', 'r'),
    c('container folder', E, 'e1', 'container', 'f:5f0c3c1e-4c1b-4f8e-9d2a-1b2c3d4e5f60'),
    c('container entry', E, 'e1', 'container', 'e:e2'),
    c('folder container', F, 'f1', 'container', 'f:f0'),
    c('created_at ISO', E, 'e1', 'created_at', '2025-01-02T03:04:05.678Z'),
    c('created_at GRDB', E, 'e1', 'created_at', '2025-01-02 03:04:05.678'),
    c('created_at GRDB without fraction', E, 'e1', 'created_at', '2025-01-02 03:04:05'),
    c('created_at with offset', E, 'e1', 'created_at', '2025-01-02T05:04:05.678+02:00'),
    c('created_at date only', E, 'e1', 'created_at', '2024-02-29'),
    c('created_at unparseable falls back to text', E, 'e1', 'created_at', 'yesterday'),
    c('created_at empty string is text', E, 'e1', 'created_at', ''),
    c('created_at null', E, 'e1', 'created_at', null),
    c('credential_id empty equals null', E, 'e1', 'credential_id', ''),
    c('credential_id id', E, 'e1', 'credential_id', 'e2'),
    c('history entry_id', H, 'h1', 'entry_id', 'e1'),
    c('history changed_at GRDB', H, 'h1', 'changed_at', '2025-01-02 03:04:05.678'),
    c('history changed_by', H, 'h1', 'changed_by', 'conflict'),
    c('meta vault_id', M, 'meta', 'vault_id', '0d9f7c2e-5b1a-4c3d-8e9f-a0b1c2d3e4f5'),
    c('meta cloud_sync_enabled', M, 'meta', 'cloud_sync_enabled', 'true'),
    c('_sync epoch', S, 'key', 'epoch', '00112233445566778899aabbccddeeff'),
    c('_sync owner JSON', S, 'owner', 'owner', '{"d":"device-uuid","a":null}'),
    c('_sync dismiss flag', S, 'dismiss', 'abcd', 1),
    c('_sync device presence JSON', S, 'device', 'device-uuid', '{"platform":"darwin","name":"MacBook","last_active_ms":1759000000000}'),
  ];
}

const RFC8785_NUMBERS: ReadonlyArray<readonly [string, string | null]> = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['7fffffffffffffff', null],
  ['7ff0000000000000', null],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

/** Expected outputs published in RFC 8785 appendix B, checked independently of our code. */
export const RFC8785_EXPECTED: ReadonlyMap<string, string | null> = new Map(RFC8785_NUMBERS);

function jcsCases(): CaseInput[] {
  const j = (name: string, json: string): CaseInput => named('jcs', name, { json });
  return [
    j('RFC 8785 3.2.3 key sorting by UTF-16 code units', '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}'),
    j('nested objects sorted recursively', '{"b":1,"a":{"d":[3,{"z":1,"y":2}],"c":null}}'),
    j('whitespace removed', ' { "a" : [ 1 , 2 ] , "b" : { } } '),
    j('string escapes', '"\\u0000\\b\\t\\n\\f\\r\\"\\\\\\/\\u001f\\u007f\\u2028\\u2029"'),
    j('unicode escapes become raw UTF-8', '"\\u00e9\\ud83d\\ude00\\u20ac"'),
    j('literals', '[true,false,null]'),
    j('number forms', '[1.0,1e2,-0,0.000001,1e-7,123456789012345678901234567890,1E21,5E-324]'),
    j('number overflow rejected', '1E400'),
    j('invalid JSON rejected', '{nope'),
    j('empty containers', '{"a":{},"b":[]}'),
    ...RFC8785_NUMBERS.map(([bits]) => named('jcsNumber', `IEEE-754 ${bits}`, { ieee754: bits })),
  ];
}

const TIMESTAMP_TEXTS: readonly string[] = [
  '2025-01-02T03:04:05.678Z',
  '2025-01-02T03:04:05Z',
  '2025-01-02T03:04Z',
  '2025-01-02T03:04:05',
  '2025-01-02 03:04:05.678',
  '2025-01-02 03:04',
  '2025-01-02T03:04:05.123456Z',
  '2025-01-02T03:04:05.9999Z',
  '2025-01-02T03:04:05.5Z',
  '2025-03-01T00:30:00+01:00',
  '2025-01-02T00:30:00-05:30',
  '2025-01-01T00:00:00-00:00',
  '2024-02-29',
  '2000-02-29T12:00:00Z',
  '1969-12-31T23:59:59.999Z',
  '0000-01-01T00:00:00Z',
  '9999-12-31T23:59:59.999Z',
  '2023-02-29',
  '1900-02-29T00:00:00Z',
  '2025-13-01T00:00:00Z',
  '2025-04-31T00:00:00Z',
  '2025-01-01T24:00:00Z',
  '2025-01-01T23:60:00Z',
  '2025-01-01T23:59:60Z',
  '2025-01-01T00:00:00+24:00',
  '2025-01-01T00:00:00+0200',
  '2025-01-01 03:04:05Z',
  '2025-01-01t03:04:05z',
  '2025-01-01T00:00:00.Z',
  ' 2025-01-01T00:00:00Z',
  '2025-1-1',
  '20250101T000000Z',
  '0000-01-01T00:30:00+01:00',
  '9999-12-31T23:30:00-01:00',
  '',
];

function timeCases(): CaseInput[] {
  return [
    ...TIMESTAMP_TEXTS.map((text) => named('parseTimestamp', JSON.stringify(text), { text })),
    ...[0, WALL + 123, -1, 253_402_300_799_999, -62_167_219_200_000].map((ms) => named('formatIsoMs', String(ms), { ms })),
    ...([
      ['null', null],
      ['garbage', 'garbage'],
      ['ISO', '2025-01-02T03:04:05.678Z'],
      ['GRDB', '2025-01-02 03:04:05.678'],
      ['integer is not a timestamp', 1_700_000_000_000],
      ['before 1970', '1969-12-31T23:59:59.999Z'],
      ['bytes', { hex: '323032352d30312d3032' }],
    ] as const).map(([name, value]) => named('parseLegacyTime', name, { value })),
  ];
}

export function canonInputs(): CaseInput[] {
  const secrets = [null, '', 'hunter2', '密码', 'pässwörd 🔐'];
  return [
    ...canonCases(),
    ...secrets.map((plaintext) => named('canonSecret', JSON.stringify(plaintext), { plaintext })),
    ...jcsCases(),
    ...timeCases(),
  ];
}

// ---------- hlc.json ----------

export const HLC_NOTES: readonly string[] = [
  'Hybrid logical clock of spec 4.1. Stamps are {ms, c}. HLC_MAX_COUNTER = 65535; FUTURE_CAP_MS = 86400000.',
  ASCII_NOTE,
  'maxReceivable: max vv entry, ignoring devs not in ownDevs whose ms > wallMs + FUTURE_CAP_MS; null when none.',
  'clock: a scripted HlcClock; each step reports the stamp after the step (tick result, or peek after receive).',
];

export function hlcInputs(): CaseInput[] {
  const t = (name: string, prev: { ms: number; c: number }, wallMs: number): CaseInput => named('tick', name, { prev, wallMs });
  return [
    t('wall ahead', { ms: WALL - 5, c: 9 }, WALL),
    t('wall equal', { ms: WALL, c: 3 }, WALL),
    t('wall behind', { ms: WALL, c: 3 }, WALL - 1000),
    t('counter at max - 1', { ms: WALL, c: HLC_MAX_COUNTER - 1 }, WALL),
    t('counter overflow, wall equal', { ms: WALL, c: HLC_MAX_COUNTER }, WALL),
    t('counter overflow, wall behind', { ms: WALL, c: HLC_MAX_COUNTER }, WALL - 50),
    named('startHlc', 'no own stamps', { wallMs: WALL, own: [] }),
    named('startHlc', 'older own stamp', { wallMs: WALL, own: [{ ms: WALL - 1, c: 99 }] }),
    named('startHlc', 'same ms, higher counter wins', { wallMs: WALL, own: [{ ms: WALL, c: 4 }, { ms: WALL, c: 2 }] }),
    named('startHlc', 'future-dated own stamp', { wallMs: WALL, own: [{ ms: WALL + 3 * FUTURE_CAP_MS, c: 1 }] }),
    named('ownStamps', 'devs of this install by dev', { vv: [[7, 50, 1], [3, 90, 0], [5, 10, 2]], devs: [[7, 'me'], [3, 'me'], [5, 'other'], [9, 'me']], deviceUuid: 'me' }),
    named('maxReceivable', 'empty vv', { wallMs: WALL, vv: [], ownDevs: [] }),
    named('maxReceivable', 'other install beyond the cap is ignored', { wallMs: WALL, vv: [[1, WALL + FUTURE_CAP_MS + 1, 0], [2, WALL + FUTURE_CAP_MS, 3], [3, WALL - 10, 5]], ownDevs: [] }),
    named('maxReceivable', 'own future stamp is kept', { wallMs: WALL, vv: [[1, WALL + FUTURE_CAP_MS + 1, 0], [2, WALL + FUTURE_CAP_MS, 3]], ownDevs: [1] }),
    named('maxReceivable', 'only capped entries', { wallMs: WALL, vv: [[1, WALL + FUTURE_CAP_MS + 1, 0]], ownDevs: [] }),
    named('clock', 'tick, receive, cap by rule', {
      start: { ms: WALL - 100, c: 0 },
      script: [
        { op: 'tick', now: WALL },
        { op: 'tick', now: WALL },
        { op: 'receive', seen: { ms: WALL + 500, c: 7 } },
        { op: 'tick', now: WALL },
        { op: 'receive', seen: { ms: WALL, c: 0 } },
        { op: 'receive', seen: null },
        { op: 'tick', now: WALL + 1000 },
        { op: 'tick', now: WALL - 5000 },
        { op: 'receive', seen: { ms: WALL + 1000, c: HLC_MAX_COUNTER } },
        { op: 'tick', now: WALL },
      ],
    }),
  ];
}
