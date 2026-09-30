/**
 * Device-local state per lineage (spec 3.2 local.json): schema validation, JSON encoding of
 * held legacy siblings (value-codec for bytes), atomic tmp+rename writes, and moving a corrupt
 * file to parked/ so it can be rebuilt from W. Local items never decide data (4.10).
 * Validation lives in local-state-validate.ts and is re-exported here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LINEAGE_DIRS, LINEAGE_FILES, isErrno, writeFileAtomic } from './paths.js';
import { encodeValue } from './value-codec.js';
import { LOCAL_JSON_VERSION, validateLocalJson } from './local-state-validate.js';
import type { Dev, HeldLegacyChange, LocalJson } from './types.js';

export { LOCAL_JSON_VERSION, validateLocalJson } from './local-state-validate.js';
export type { LocalJsonValidation } from './local-state-validate.js';

const JSON_INDENT = 2;
const PARKED_PREFIX = 'local-';
const PARKED_EXT = '.json';
/** Parking twice in the same millisecond is possible in tests; bounded so a bug cannot spin. */
const MAX_PARK_SUFFIX = 1000;

export function defaultLocalJson(lineageId: string, dev: Dev, incarnation: string): LocalJson {
  return {
    version: LOCAL_JSON_VERSION,
    lineageId,
    binding: null,
    dev,
    incarnation,
    lastMergedSha256: null,
    lastPublished: null,
    pendingPublish: false,
    sideFiles: null,
    heldLegacy: [],
    snoozed: [],
    lastLimit: null,
    ignoredCopies: [],
    abandonedWaits: [],
    notices: [],
    candidateLabels: {},
    contentRepairShas: [],
    sideFilesConfirmedAtMs: null,
  };
}

/** JSON text for local.json; byte values in held siblings use value-codec. */
export function serializeLocalJson(value: LocalJson): string {
  const doc = { ...value, heldLegacy: value.heldLegacy.map(encodeHeld) };
  return `${JSON.stringify(doc, null, JSON_INDENT)}\n`;
}

function encodeHeld(h: HeldLegacyChange): object {
  return { ...h, sibling: { ...h.sibling, value: encodeValue(h.sibling.value) } };
}

export interface LocalJsonRead {
  /** null when missing or corrupt. */
  readonly value: LocalJson | null;
  /** Path the corrupt file was moved to, if any. */
  readonly parkedTo: string | null;
  /** Why the file was parked (JSON paths only, never values); empty otherwise. */
  readonly errors: readonly string[];
}

/** Reads and validates {lineageDir}/local.json; a corrupt file is moved to parked/. */
export function readLocalJson(lineageDir: string, nowMs: number): LocalJsonRead {
  const file = path.join(lineageDir, LINEAGE_FILES.local);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { value: null, parkedTo: null, errors: [] };
    throw err;
  }
  const parsed = parseLocalText(text);
  if (parsed.kind === 'ok') return { value: parsed.value, parkedTo: null, errors: [] };
  return { value: null, parkedTo: parkFile(lineageDir, file, nowMs), errors: parsed.errors };
}

type Parsed = { readonly kind: 'ok'; readonly value: LocalJson } | { readonly kind: 'bad'; readonly errors: readonly string[] };

function parseLocalText(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'bad', errors: ['$: not valid JSON'] };
  }
  const v = validateLocalJson(raw);
  return v.ok ? { kind: 'ok', value: v.value } : { kind: 'bad', errors: v.errors };
}

/** Moves a corrupt local.json to parked/local-<now>.json (suffixed when that name is taken). */
function parkFile(lineageDir: string, file: string, nowMs: number): string {
  const parkedDir = path.join(lineageDir, LINEAGE_DIRS.parked);
  fs.mkdirSync(parkedDir, { recursive: true });
  for (let i = 0; i < MAX_PARK_SUFFIX; i++) {
    const name = `${PARKED_PREFIX}${nowMs}${i === 0 ? '' : `-${i}`}${PARKED_EXT}`;
    const target = path.join(parkedDir, name);
    if (fs.existsSync(target)) continue;
    fs.renameSync(file, target);
    return target;
  }
  throw new Error('local-state: no free parked/ name for a corrupt local.json');
}

/** Atomic write: tmp file in the same folder, fsync, rename. */
export function writeLocalJson(lineageDir: string, value: LocalJson): void {
  const text = serializeLocalJson(value);
  const check = validateLocalJson(JSON.parse(text));
  if (!check.ok) throw new Error(`local-state: refusing to write an invalid local.json: ${check.errors.join('; ')}`);
  fs.mkdirSync(lineageDir, { recursive: true });
  writeFileAtomic(path.join(lineageDir, LINEAGE_FILES.local), text);
}

/**
 * Read (or default), apply `fn`, write atomically; returns the written value. When the file
 * was valid and `fn` returns the same object, nothing is written.
 */
export function updateLocalJson(
  lineageDir: string,
  fallback: LocalJson,
  fn: (current: LocalJson) => LocalJson,
  nowMs: number,
): LocalJson {
  const read = readLocalJson(lineageDir, nowMs);
  const current = read.value ?? fallback;
  const next = fn(current);
  if (next === current && read.value !== null) return current;
  writeLocalJson(lineageDir, next);
  return next;
}
