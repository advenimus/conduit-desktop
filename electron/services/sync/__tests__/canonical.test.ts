// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CANON_TAG,
  canon,
  canonEqual,
  canonSecret,
  formatIsoMs,
  parseLegacyTime,
  parseTimestamp,
} from '../canonical.js';
import { configReg, fixedDef, metaRegKey, ownerRegKey, registerDef, requireDef, tagReg } from '../catalog.js';
import { TBL, type RegisterDef, type SyncValue } from '../types.js';

const entry = (reg: string): RegisterDef => requireDef({ tbl: TBL.entries, rowId: 'e1', reg });
const hexOf = (b: Buffer): string => b.toString('hex');
const tagged = (tag: number, text: string): string => hexOf(Buffer.concat([Buffer.of(tag), Buffer.from(text, 'utf8')]));
const NULL_HEX = '00';

describe('canon by value kind (spec 3.6)', () => {
  it('encodes _life and required text, keeping the empty string', () => {
    expect(hexOf(canon(entry('_life'), 'live'))).toBe(tagged(CANON_TAG.text, 'live'));
    expect(hexOf(canon(entry('name'), ''))).toBe('02');
    expect(hexOf(canon(entry('name'), null))).toBe(NULL_HEX);
    expect(hexOf(canon(entry('entry_type'), 'ssh'))).toBe(tagged(CANON_TAG.text, 'ssh'));
  });

  it('treats empty optional text and references as NULL', () => {
    for (const reg of ['host', 'notes', 'credential_id']) {
      expect(hexOf(canon(entry(reg), ''))).toBe(NULL_HEX);
      expect(hexOf(canon(entry(reg), null))).toBe(NULL_HEX);
    }
    expect(hexOf(canon(entry('host'), 'db.example.com'))).toBe(tagged(CANON_TAG.text, 'db.example.com'));
    expect(hexOf(canon(requireDef(metaRegKey('vault_id')), 'v-1'))).toBe(tagged(CANON_TAG.text, 'v-1'));
  });

  it('does not normalize Unicode', () => {
    expect(canon(entry('name'), 'café').equals(canon(entry('name'), 'café'))).toBe(false);
  });

  it('decodes byte values of text registers as UTF-8', () => {
    expect(hexOf(canon(entry('host'), Buffer.from('hé', 'utf8')))).toBe(tagged(CANON_TAG.text, 'hé'));
  });

  it('encodes integers as ASCII decimal and keeps non-numeric legacy text as text', () => {
    const port = entry('port');
    expect(hexOf(canon(port, 22))).toBe(tagged(CANON_TAG.int, '22'));
    expect(hexOf(canon(port, '22'))).toBe(tagged(CANON_TAG.int, '22'));
    expect(hexOf(canon(port, ' 22 '))).toBe(tagged(CANON_TAG.int, '22'));
    expect(hexOf(canon(port, -1))).toBe(tagged(CANON_TAG.int, '-1'));
    expect(hexOf(canon(port, 'ssh'))).toBe(tagged(CANON_TAG.text, 'ssh'));
    expect(hexOf(canon(port, ''))).toBe(NULL_HEX);
    expect(hexOf(canon(port, null))).toBe(NULL_HEX);
  });

  it('maps NULL sort_order and is_favorite to 0', () => {
    expect(hexOf(canon(entry('sort_order'), null))).toBe(tagged(CANON_TAG.int, '0'));
    expect(hexOf(canon(entry('is_favorite'), '1'))).toBe(tagged(CANON_TAG.int, '1'));
    expect(hexOf(canon(fixedDef(TBL.folders, 'sort_order'), 7))).toBe(tagged(CANON_TAG.int, '7'));
  });

  it('encodes flags as present or absent', () => {
    const tag = entry(tagReg('prod'));
    expect(hexOf(canon(tag, 1))).toBe(tagged(CANON_TAG.int, '1'));
    expect(hexOf(canon(tag, null))).toBe(NULL_HEX);
  });

  it('re-canonicalizes JSON with JCS and keeps invalid JSON text as is', () => {
    const cfg = entry(configReg('rdp'));
    expect(hexOf(canon(cfg, '{ "b": [1, 2.50], "a": "x" }'))).toBe(tagged(CANON_TAG.json, '{"a":"x","b":[1,2.5]}'));
    expect(hexOf(canon(cfg, 'null'))).toBe(tagged(CANON_TAG.json, 'null'));
    expect(hexOf(canon(cfg, null))).toBe(NULL_HEX);
    expect(hexOf(canon(cfg, '{broken'))).toBe(tagged(CANON_TAG.json, '{broken'));
    expect(hexOf(canon(cfg, '1E400'))).toBe(tagged(CANON_TAG.json, '1E400'));
    expect(hexOf(canon(requireDef(ownerRegKey()), '{"d":"u","a":null}'))).toBe(
      tagged(CANON_TAG.json, '{"a":null,"d":"u"}'),
    );
  });

  it('encodes containers', () => {
    expect(hexOf(canon(entry('container'), 'r'))).toBe(tagged(CANON_TAG.container, 'r'));
    expect(hexOf(canon(entry('container'), 'e:abc'))).toBe(tagged(CANON_TAG.container, 'e:abc'));
    expect(hexOf(canon(fixedDef(TBL.folders, 'container'), 'f:x'))).toBe(tagged(CANON_TAG.container, 'f:x'));
  });

  it('encodes timestamps as ISO UTC with milliseconds and falls back to text', () => {
    const created = entry('created_at');
    const iso = tagged(CANON_TAG.time, '2025-01-02T03:04:05.678Z');
    expect(hexOf(canon(created, '2025-01-02T03:04:05.678Z'))).toBe(iso);
    expect(hexOf(canon(created, '2025-01-02 03:04:05.678'))).toBe(iso);
    expect(hexOf(canon(created, '2025-01-02T05:04:05.678+02:00'))).toBe(iso);
    expect(hexOf(canon(created, 'yesterday'))).toBe(tagged(CANON_TAG.text, 'yesterday'));
    expect(hexOf(canon(created, ''))).toBe('02');
    expect(hexOf(canon(created, null))).toBe(NULL_HEX);
    expect(hexOf(canon(fixedDef(TBL.history, 'changed_at'), '2024-02-29'))).toBe(
      tagged(CANON_TAG.time, '2024-02-29T00:00:00.000Z'),
    );
  });

  it('refuses secret registers', () => {
    expect(() => canon(entry('password'), null)).toThrow(/secret/);
    expect(() => canonEqual(entry('totp_secret'), null, null)).toThrow(/secret/);
  });

  it('encodes secrets from plaintext only', () => {
    expect(hexOf(canonSecret(null))).toBe(NULL_HEX);
    expect(hexOf(canonSecret(''))).toBe(NULL_HEX);
    expect(hexOf(canonSecret('hunter2'))).toBe(tagged(CANON_TAG.secret, 'hunter2'));
    expect(hexOf(canonSecret('密码'))).toBe(tagged(CANON_TAG.secret, '密码'));
  });
});

describe('canonEqual', () => {
  it('compares canonically, not by stored form', () => {
    expect(canonEqual(entry('host'), '', null)).toBe(true);
    expect(canonEqual(entry('port'), '22', 22)).toBe(true);
    expect(canonEqual(entry('sort_order'), null, 0)).toBe(true);
    expect(canonEqual(entry('created_at'), '2025-01-02 03:04:05', '2025-01-02T03:04:05.000Z')).toBe(true);
    expect(canonEqual(entry(configReg('x')), '{"a":1,"b":2}', '{"b":2,"a":1}')).toBe(true);
    expect(canonEqual(entry('name'), '', null)).toBe(false);
    expect(canonEqual(entry('port'), '22', 23)).toBe(false);
  });

  const value = fc.oneof(
    fc.constant(null),
    fc.integer({ min: -5, max: 5 }),
    fc.constantFrom('', ' ', '1', '01', 'x', '{}', '{"a":1}', '{ "a" : 1 }', '2025-01-02 03:04:05', '2025-01-02T03:04:05Z'),
  );
  const regs = ['name', 'host', 'port', 'sort_order', 'container', 'created_at', 'credential_id', configReg('k'), tagReg('t')];

  it('agrees with byte equality of canon() for every kind (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...regs), value, value, (reg, a: SyncValue, b: SyncValue) => {
        const def = entry(reg);
        expect(canonEqual(def, a, b)).toBe(canon(def, a).equals(canon(def, b)));
      }),
    );
  });
});

describe('parseTimestamp and formatIsoMs', () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ['2025-01-02T03:04:05.678Z', '2025-01-02T03:04:05.678Z'],
    ['2025-01-02T03:04:05Z', '2025-01-02T03:04:05.000Z'],
    ['2025-01-02T03:04Z', '2025-01-02T03:04:00.000Z'],
    ['2025-01-02T03:04:05', '2025-01-02T03:04:05.000Z'],
    ['2025-01-02 03:04:05.678', '2025-01-02T03:04:05.678Z'],
    ['2025-01-02 03:04', '2025-01-02T03:04:00.000Z'],
    ['2025-01-02T03:04:05.123456Z', '2025-01-02T03:04:05.123Z'],
    ['2025-01-02T03:04:05.9999Z', '2025-01-02T03:04:05.999Z'],
    ['2025-01-02T03:04:05.5Z', '2025-01-02T03:04:05.500Z'],
    ['2025-03-01T00:30:00+01:00', '2025-02-28T23:30:00.000Z'],
    ['2025-01-02T00:30:00-05:30', '2025-01-02T06:00:00.000Z'],
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2000-02-29T12:00:00Z', '2000-02-29T12:00:00.000Z'],
    ['1969-12-31T23:59:59.999Z', '1969-12-31T23:59:59.999Z'],
    ['0000-01-01T00:00:00Z', '0000-01-01T00:00:00.000Z'],
    ['9999-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'],
    ['2023-02-29', null],
    ['1900-02-29T00:00:00Z', null],
    ['2025-13-01T00:00:00Z', null],
    ['2025-00-01T00:00:00Z', null],
    ['2025-04-31T00:00:00Z', null],
    ['2025-01-01T24:00:00Z', null],
    ['2025-01-01T23:60:00Z', null],
    ['2025-01-01T23:59:60Z', null],
    ['2025-01-01T00:00:00+24:00', null],
    ['2025-01-01T00:00:00+0200', null],
    ['2025-01-01 03:04:05Z', null],
    ['2025-01-01t03:04:05z', null],
    ['2025-01-01T00:00:00.Z', null],
    [' 2025-01-01T00:00:00Z', null],
    ['2025-1-1', null],
    ['20250101T000000Z', null],
    ['0000-01-01T00:30:00+01:00', null],
    ['9999-12-31T23:30:00-01:00', null],
    ['', null],
    ['yesterday', null],
  ];

  it.each(cases)('parses %j', (text, iso) => {
    const ms = parseTimestamp(text);
    expect(ms === null ? null : formatIsoMs(ms)).toBe(iso);
  });

  const YEAR_0000_MS = -62_167_219_200_000;
  const YEAR_9999_END_MS = 253_402_300_799_999;

  it('round-trips every instant of years 0000..9999 in ISO and GRDB form (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: YEAR_0000_MS, max: YEAR_9999_END_MS }), (ms) => {
        const iso = formatIsoMs(ms);
        expect(parseTimestamp(iso)).toBe(ms);
        expect(parseTimestamp(iso.replace('T', ' ').replace('Z', ''))).toBe(ms);
      }),
    );
    expect(formatIsoMs(YEAR_0000_MS)).toBe('0000-01-01T00:00:00.000Z');
    expect(parseTimestamp(formatIsoMs(YEAR_0000_MS - 1))).toBeNull();
  });
});

describe('parseLegacyTime', () => {
  it('returns ms, or 0 when missing, unparseable or before 1970', () => {
    expect(parseLegacyTime('2025-01-02T03:04:05.678Z')).toBe(Date.UTC(2025, 0, 2, 3, 4, 5, 678));
    expect(parseLegacyTime('2025-01-02 03:04:05.678')).toBe(Date.UTC(2025, 0, 2, 3, 4, 5, 678));
    expect(parseLegacyTime(Buffer.from('2025-01-02', 'utf8'))).toBe(Date.UTC(2025, 0, 2));
    expect(parseLegacyTime(null)).toBe(0);
    expect(parseLegacyTime('garbage')).toBe(0);
    expect(parseLegacyTime(1_700_000_000_000)).toBe(0);
    expect(parseLegacyTime(BigInt(5))).toBe(0);
    expect(parseLegacyTime('1969-12-31T23:59:59.999Z')).toBe(0);
  });
});

describe('catalog coverage', () => {
  it('has a canon rule for every non-secret catalog kind', () => {
    const defs = [TBL.entries, TBL.folders, TBL.history, TBL.meta].flatMap((tbl) =>
      ['_life', 'name', 'container', 'sort_order', 'created_at', 'changed_at', 'entry_id', 'vault_id'].flatMap((reg) => {
        const d = registerDef({ tbl, rowId: 'r', reg });
        return d === null || d.secret ? [] : [d];
      }),
    );
    for (const d of defs) expect(canon(d, d.defaultValue).length).toBeGreaterThan(0);
  });
});
