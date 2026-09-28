/**
 * On-disk form of pending candidates (spec 4.9): `<id>.json` holds the
 * meta (payload file names relative to candidates/), `<id>.conduit` a private file payload and
 * `<id>.rows.json` G3 leftovers (CandidateRows with value-codec values). Parsing is strict: a
 * file that does not validate is a corrupt entry the queue parks. Import through candidate-queue.ts.
 */

import path from 'node:path';
import { decodeValue, encodeValue } from './value-codec.js';
import { parseRowKeyStr } from './state-view.js';
import type { PendingCandidate, PendingPayload } from './candidate-queue.js';
import type { CandidateKind, CandidateRowValues, CandidateRows, CandidateSource, CandidateValue, SyncValue, Tbl } from './types.js';

export const META_SUFFIX = '.json';
export const ROWS_SUFFIX = '.rows.json';
export const FILE_SUFFIX = '.conduit';
const STORE_VERSION = 1;
const SOURCES: ReadonlySet<string> = new Set<CandidateSource>([
  'ios-sandbox',
  'copy',
  'leftover-wal',
  'presync-no-baseline',
  'user-picked',
  'genesis-leftovers',
]);
const KINDS: ReadonlySet<string> = new Set<CandidateKind>(['replica', 'synthetic']);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/;

/** A candidate id is a UUID; anything else never becomes a file name. */
export function isCandidateId(id: string): boolean {
  return ID_RE.test(id);
}

export function metaName(id: string): string {
  return `${id}${META_SUFFIX}`;
}

/** candidates/<id>.json names only (not the rows payloads). */
export function idOfMetaName(name: string): string | null {
  if (!name.endsWith(META_SUFFIX) || name.endsWith(ROWS_SUFFIX)) return null;
  const id = name.slice(0, -META_SUFFIX.length);
  return isCandidateId(id) ? id : null;
}

interface StoredMeta {
  readonly version: number;
  readonly id: string;
  readonly source: CandidateSource;
  readonly label: string;
  readonly kind: CandidateKind;
  readonly staleByNature: boolean;
  readonly createdMs: number;
  readonly payload: { readonly kind: 'file'; readonly file: string; readonly sha256: string } | { readonly kind: 'rows'; readonly file: string; readonly epochId: string };
}

export function encodeMeta(c: PendingCandidate): string {
  const file = path.basename(c.payload.path);
  const payload: StoredMeta['payload'] =
    c.payload.kind === 'file' ? { kind: 'file', file, sha256: c.payload.sha256 } : { kind: 'rows', file, epochId: c.payload.epochId };
  const meta: StoredMeta = {
    version: STORE_VERSION,
    id: c.id,
    source: c.source,
    label: c.label,
    kind: c.kind,
    staleByNature: c.staleByNature,
    createdMs: c.createdMs,
    payload,
  };
  return JSON.stringify(meta);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parsePayload(raw: unknown, id: string, dir: string): PendingPayload | null {
  if (!isRecord(raw) || typeof raw.file !== 'string') return null;
  if (raw.kind === 'file' && raw.file === `${id}${FILE_SUFFIX}` && typeof raw.sha256 === 'string' && SHA_RE.test(raw.sha256)) {
    return { kind: 'file', path: path.join(dir, raw.file), sha256: raw.sha256 };
  }
  if (raw.kind === 'rows' && raw.file === `${id}${ROWS_SUFFIX}` && typeof raw.epochId === 'string' && raw.epochId.length > 0) {
    return { kind: 'rows', path: path.join(dir, raw.file), epochId: raw.epochId };
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The meta of candidates/<id>.json, or null when it does not validate. */
export function decodeMeta(text: string, id: string, dir: string): PendingCandidate | null {
  const raw = parseJson(text);
  if (!isRecord(raw) || raw.version !== STORE_VERSION || raw.id !== id) return null;
  const { source, label, kind, staleByNature, createdMs } = raw;
  if (typeof source !== 'string' || !SOURCES.has(source) || typeof label !== 'string') return null;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof staleByNature !== 'boolean') return null;
  if (typeof createdMs !== 'number' || !Number.isFinite(createdMs)) return null;
  const payload = parsePayload(raw.payload, id, dir);
  if (payload === null) return null;
  return Object.freeze({ id, source: source as CandidateSource, label, kind: kind as CandidateKind, staleByNature, payload, createdMs });
}

// ---------- rows payload ----------

type StoredValue = readonly [string, { readonly value: unknown; readonly vhash: string; readonly flags: number }];
type StoredRow = readonly [string, { readonly rowTimeMs: number; readonly values: readonly StoredValue[] }];

export function encodeRows(rows: CandidateRows): string {
  const out: StoredRow[] = [];
  for (const [k, r] of rows) {
    const values: StoredValue[] = [...r.values].map(([reg, v]) => [reg, { value: encodeValue(v.value), vhash: v.vhash, flags: v.flags }]);
    out.push([k, { rowTimeMs: r.rowTimeMs, values }]);
  }
  return JSON.stringify({ version: STORE_VERSION, rows: out });
}

function safeDecode(x: unknown): { readonly ok: true; readonly value: SyncValue } | { readonly ok: false } {
  try {
    return { ok: true, value: decodeValue(x) };
  } catch {
    return { ok: false };
  }
}

function decodeValueEntry(raw: unknown): readonly [string, CandidateValue] | null {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string' || !isRecord(raw[1])) return null;
  const { value, vhash, flags } = raw[1];
  if (typeof vhash !== 'string' || typeof flags !== 'number' || !Number.isInteger(flags)) return null;
  const decoded = safeDecode(value);
  if (!decoded.ok) return null;
  return [raw[0], Object.freeze({ value: decoded.value, vhash, flags })];
}

function decodeRow(raw: unknown): readonly [string, CandidateRowValues] | null {
  if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string' || !isRecord(raw[1])) return null;
  const { rowTimeMs, values } = raw[1];
  if (typeof rowTimeMs !== 'number' || !Array.isArray(values)) return null;
  const row = parseRowKeyStr(raw[0]);
  if (!Number.isInteger(row.tbl) || row.rowId.length === 0) return null;
  const decoded = values.map(decodeValueEntry);
  if (decoded.some((v) => v === null)) return null;
  const map = new Map(decoded as (readonly [string, CandidateValue])[]);
  return [raw[0], Object.freeze({ row: { tbl: row.tbl as Tbl, rowId: row.rowId }, rowTimeMs, values: map })];
}

/** CandidateRows of a rows payload; throws when the file does not validate. */
export function decodeRows(text: string): CandidateRows {
  const raw = parseJson(text);
  if (!isRecord(raw) || raw.version !== STORE_VERSION || !Array.isArray(raw.rows)) {
    throw new Error('[sync] candidate rows payload is not valid');
  }
  const rows = raw.rows.map(decodeRow);
  if (rows.some((r) => r === null)) throw new Error('[sync] candidate rows payload is not valid');
  return new Map(rows as (readonly [string, CandidateRowValues])[]);
}
