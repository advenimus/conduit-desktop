/**
 * canon(v) of spec 3.6: the tagged byte encoding every vhash is computed over, plus timestamp
 * parsing (ISO 8601 and GRDB "YYYY-MM-DD HH:MM:SS(.SSS)") and formatting. Byte-exact parity
 * with the Swift port is a CI gate (13.1 golden vectors in __vectors__/canon.json).
 * JCS lives in jcs.ts and is re-exported here.
 */

import { asInt, asText, normalizeValue } from './catalog.js';
import { jcsFromText } from './jcs.js';
import { valuesIdentical } from './sibling.js';
import type { RegisterDef, SqlValue, SyncValue } from './types.js';

export { jcs, jcsFromText, jcsObjectFromEntries } from './jcs.js';

/** Leading tag byte of canon() by value class (3.6 table). */
export const CANON_TAG = {
  null: 0x00,
  int: 0x01,
  text: 0x02,
  secret: 0x03,
  json: 0x04,
  container: 0x05,
  time: 0x07,
} as const;

const FLAG_TEXT = '1';

// ---------- canon ----------

function tagged(tag: number, text: string): Buffer {
  const len = Buffer.byteLength(text, 'utf8');
  const out = Buffer.allocUnsafe(len + 1);
  out[0] = tag;
  out.write(text, 1, 'utf8');
  return out;
}

function nullCanon(): Buffer {
  return Buffer.of(CANON_TAG.null);
}

/** NULL -> 0x00; otherwise `tag` + UTF-8 (the empty string is a real value). */
function requiredText(tag: number, text: string | null): Buffer {
  return text === null ? nullCanon() : tagged(tag, text);
}

/** NULL or '' -> 0x00; otherwise 0x02 + UTF-8. */
function optionalText(text: string | null): Buffer {
  return text === null || text.length === 0 ? nullCanon() : tagged(CANON_TAG.text, text);
}

/** number -> 0x01 + decimal; a non-numeric legacy string -> 0x02 + text; NULL -> 0x00. */
function intCanon(v: number | string | null): Buffer {
  if (v === null) return nullCanon();
  return typeof v === 'number' ? tagged(CANON_TAG.int, String(v)) : tagged(CANON_TAG.text, v);
}

/** Re-canonicalizes JSON text; text that is not valid JSON (or not JCS-representable) stays as is. */
function jsonCanon(text: string | null): Buffer {
  if (text === null) return nullCanon();
  return tagged(CANON_TAG.json, jcsFromText(text) ?? text);
}

function timeCanon(text: string | null): Buffer {
  if (text === null) return nullCanon();
  const ms = parseTimestamp(text);
  return ms === null ? tagged(CANON_TAG.text, text) : tagged(CANON_TAG.time, formatIsoMs(ms));
}

/**
 * canon(v) for a NON-secret register value, per the register's ValueKind.
 * Throws for secret registers (use canonSecret with the plaintext).
 */
export function canon(def: RegisterDef, value: SyncValue): Buffer {
  switch (def.kind) {
    case 'life':
    case 'reqtext':
      return requiredText(CANON_TAG.text, asText(value));
    case 'container':
      return requiredText(CANON_TAG.container, asText(value));
    case 'text':
    case 'ref':
      return optionalText(asText(value));
    case 'int':
      return intCanon(asInt(value));
    case 'int0':
      return intCanon(asInt(value) ?? 0);
    case 'flag':
      return normalizeValue(def, value) === null ? nullCanon() : tagged(CANON_TAG.int, FLAG_TEXT);
    case 'json':
      return jsonCanon(asText(value));
    case 'time':
      return timeCanon(asText(value));
    case 'secret':
      throw new Error(`canon: ${def.reg} is a secret register; use canonSecret`);
  }
}

/** canon() of a secret: 0x03 + UTF-8 plaintext, or 0x00 for NULL / empty. */
export function canonSecret(plaintext: string | null): Buffer {
  return plaintext === null || plaintext.length === 0 ? nullCanon() : tagged(CANON_TAG.secret, plaintext);
}

/**
 * True when canon(def, a) equals canon(def, b). Never call for secret registers.
 * canon() is a function of normalizeValue(), so equal normalized values short-cut to true.
 */
export function canonEqual(def: RegisterDef, a: SyncValue, b: SyncValue): boolean {
  if (def.secret) throw new Error(`canonEqual: ${def.reg} is a secret register`);
  if (valuesIdentical(normalizeValue(def, a), normalizeValue(def, b))) return true;
  return canon(def, a).equals(canon(def, b));
}

// ---------- Timestamps ----------

const DATE_PART = '(\\d{4})-(\\d{2})-(\\d{2})';
const TIME_PART = '(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?';
const ISO_RE = new RegExp(`^${DATE_PART}T${TIME_PART}(Z|[+-]\\d{2}:\\d{2})?$`);
const GRDB_RE = new RegExp(`^${DATE_PART} ${TIME_PART}$`);
const DATE_ONLY_RE = new RegExp(`^${DATE_PART}$`);

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_HOUR = 23;
const MAX_MINUTE = 59;
const MAX_SECOND = 59;
const MONTHS = 12;
const FRACTION_DIGITS = 3;
const MIN_YEAR = 0;
const MAX_YEAR = 9999;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

interface Fields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millis: number;
  readonly offsetMinutes: number;
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeapYear(y) ? 29 : DAYS_IN_MONTH[m - 1];
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (integer arithmetic only). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** First three fraction digits, right-padded: '5' -> 500, '123456' -> 123 (truncation, not rounding). */
function fractionMillis(fraction: string | undefined): number {
  if (fraction === undefined) return 0;
  return Number(fraction.slice(0, FRACTION_DIGITS).padEnd(FRACTION_DIGITS, '0'));
}

/** 'Z' or absent -> 0; '+HH:MM' / '-HH:MM' -> signed minutes; out-of-range -> null. */
function offsetMinutesOf(zone: string | undefined): number | null {
  if (zone === undefined || zone === 'Z') return 0;
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (hours > MAX_HOUR || minutes > MAX_MINUTE) return null;
  const sign = zone[0] === '-' ? -1 : 1;
  return sign * (hours * 60 + minutes);
}

function matchFields(text: string): Fields | null {
  const m = ISO_RE.exec(text) ?? GRDB_RE.exec(text) ?? DATE_ONLY_RE.exec(text);
  if (m === null) return null;
  const offsetMinutes = offsetMinutesOf(m[8]);
  if (offsetMinutes === null) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] === undefined ? 0 : Number(m[4]),
    minute: m[5] === undefined ? 0 : Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
    millis: fractionMillis(m[7]),
    offsetMinutes,
  };
}

function fieldsInRange(f: Fields): boolean {
  if (f.month < 1 || f.month > MONTHS) return false;
  if (f.day < 1 || f.day > daysInMonth(f.year, f.month)) return false;
  return f.hour <= MAX_HOUR && f.minute <= MAX_MINUTE && f.second <= MAX_SECOND;
}

const MIN_MS = daysFromCivil(MIN_YEAR, 1, 1) * MS_PER_DAY;
const MAX_MS = daysFromCivil(MAX_YEAR + 1, 1, 1) * MS_PER_DAY - 1;

/**
 * Milliseconds since the Unix epoch, or null when the text is not ISO 8601
 * (`YYYY-MM-DDTHH:MM(:SS(.fraction))?(Z|+HH:MM|-HH:MM)?`, no zone = UTC), GRDB
 * (`YYYY-MM-DD HH:MM(:SS(.fraction))?`, UTC) or a date (`YYYY-MM-DD`, UTC midnight).
 * The fraction is truncated to milliseconds. Out-of-range fields, and instants outside
 * years 0000..9999 UTC after applying the offset, give null.
 */
export function parseTimestamp(text: string): number | null {
  const f = matchFields(text);
  if (f === null || !fieldsInRange(f)) return null;
  const ms =
    daysFromCivil(f.year, f.month, f.day) * MS_PER_DAY +
    f.hour * MS_PER_HOUR +
    f.minute * MS_PER_MINUTE +
    f.second * MS_PER_SECOND +
    f.millis -
    f.offsetMinutes * MS_PER_MINUTE;
  return ms < MIN_MS || ms > MAX_MS ? null : ms;
}

/** 'YYYY-MM-DDTHH:MM:SS.sssZ' (UTC, milliseconds): the format desktop writes (vault.ts:311). */
export function formatIsoMs(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * parseLegacyTime of 4.3: parsed `updated_at` in ms, or 0 when missing or unparseable.
 * Pre-1970 instants also give 0: lt is a non-negative rank hint and pseudo ms derive from it.
 */
export function parseLegacyTime(value: SqlValue): number {
  const text = asText(value);
  if (text === null) return 0;
  const ms = parseTimestamp(text);
  return ms === null || ms < 0 ? 0 : ms;
}
