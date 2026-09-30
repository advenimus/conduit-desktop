/**
 * JSON codec for SyncValue, used wherever a value must live in JSON text:
 * sync_grave.row_json, sync_reg.mat and local.json. Bytes become {"$b64": "<base64>"}.
 * Must match the Swift port byte for byte (the text is written into the vault file).
 */

import { jcs } from './jcs.js';
import type { SyncValue } from './types.js';

const B64_KEY = '$b64';

export type EncodedValue = null | number | string | { readonly [B64_KEY]: string };

export function encodeValue(v: SyncValue): EncodedValue {
  if (v instanceof Uint8Array) return { [B64_KEY]: Buffer.from(v).toString('base64') };
  return v;
}

export function decodeValue(x: unknown): SyncValue {
  if (x === null || typeof x === 'number' || typeof x === 'string') return x;
  if (typeof x === 'object' && x !== null && typeof (x as Record<string, unknown>)[B64_KEY] === 'string') {
    return Buffer.from((x as Record<string, string>)[B64_KEY], 'base64');
  }
  throw new Error('value-codec: not an encoded SyncValue');
}

/** JCS text of one encoded value (sync_reg.mat). */
export function valueToText(v: SyncValue): string {
  return jcs(encodeValue(v));
}

export function valueFromText(text: string): SyncValue {
  return decodeValue(JSON.parse(text));
}

/** JCS text of {reg: encoded value} (sync_grave.row_json). */
export function valuesToText(values: ReadonlyMap<string, SyncValue>): string {
  const obj: Record<string, EncodedValue> = {};
  for (const [reg, v] of values) obj[reg] = encodeValue(v);
  return jcs(obj);
}

export function valuesFromText(text: string): Map<string, SyncValue> {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('value-codec: row_json is not an object');
  }
  return new Map(Object.entries(parsed as Record<string, unknown>).map(([k, x]) => [k, decodeValue(x)] as const));
}
