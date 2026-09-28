/**
 * Strict validation of parsed local.json (spec 3.2): types, hex lengths, id formats, known
 * notice kinds, dev ranges. Built from small composable checks that collect every error with
 * its JSON path. Unknown keys are ignored so a newer build's extra fields never park the file.
 * Re-exported by local-state.ts.
 */

import { decodeValue } from './value-codec.js';
import {
  DEV_BITS,
  HASH16_HEX_LEN,
  HLC_MAX_COUNTER,
  PREV_HEX_LEN,
  SIB_REDACTED,
  SIB_UNDECRYPTABLE,
  TBL,
} from './types.js';
import type {
  FileBinding,
  HeldLegacyChange,
  LocalJson,
  LocalNotice,
  LocalNoticeKind,
  Pmem,
  RegKey,
  SideFileTuple,
  Sibling,
  SnoozeEntry,
  SyncValue,
  Tbl,
} from './types.js';

export const LOCAL_JSON_VERSION = 1;

export type LocalJsonValidation =
  | { readonly ok: true; readonly value: LocalJson }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Returns the checked value, or undefined after pushing at least one error. */
type Check<T> = (v: unknown, at: string, errs: string[]) => T | undefined;
type Shape<T> = { readonly [K in keyof T]-?: Check<T[K]> };

const SHA256_HEX_LEN = 64;
const MAX_DEV = 2 ** DEV_BITS - 1;
/** vault_max_open_devices uses -1 for unlimited (8.1), so a stored last limit may be -1. */
const UNLIMITED_LIMIT = -1;
const MAX_FLAGS = SIB_UNDECRYPTABLE | SIB_REDACTED;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEV_KEY_RE = /^[1-9][0-9]*$/;
const IDENTITY_RE = new RegExp(`^(a:[1-9][0-9]*:[0-9]+:[0-9]+|p:[0-9]+:[0-9a-f]{${HASH16_HEX_LEN}})$`);
const B64_KEY = '$b64';
const TBL_VALUES: ReadonlySet<number> = new Set(Object.values(TBL));
const NOTICE_KINDS: Readonly<Record<LocalNoticeKind, true>> = {
  'dropped-setting': true,
  'value-unrecoverable': true,
  'undecryptable-secrets': true,
  'invariant-repair': true,
  'mass-change': true,
};

// ---------- Primitive checks ----------

function fail(errs: string[], at: string, msg: string): undefined {
  errs.push(`${at}: ${msg}`);
  return undefined;
}

const bool: Check<boolean> = (v, at, errs) => (typeof v === 'boolean' ? v : fail(errs, at, 'expected boolean'));

function int(min: number, max: number = Number.MAX_SAFE_INTEGER): Check<number> {
  return (v, at, errs) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
      ? v
      : fail(errs, at, `expected integer in [${min}, ${max}]`);
}

const nonNegNumber: Check<number> = (v, at, errs) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail(errs, at, 'expected number >= 0');

function matching(re: RegExp, what: string): Check<string> {
  return (v, at, errs) => (typeof v === 'string' && re.test(v) ? v : fail(errs, at, `expected ${what}`));
}

function hex(len: number): Check<string> {
  return matching(new RegExp(`^[0-9a-f]{${len}}$`), `${len} lowercase hex chars`);
}

const nonEmptyString: Check<string> = (v, at, errs) =>
  typeof v === 'string' && v !== '' ? v : fail(errs, at, 'expected non-empty string');

function literal<T extends string | number>(values: readonly T[]): Check<T> {
  return (v, at, errs) =>
    (values as readonly unknown[]).includes(v) ? (v as T) : fail(errs, at, `expected one of ${values.join(', ')}`);
}

function nullable<T>(check: Check<T>): Check<T | null> {
  return (v, at, errs) => (v === null ? null : check(v, at, errs));
}

function arrayOf<T>(check: Check<T>): Check<readonly T[]> {
  return (v, at, errs) => {
    if (!Array.isArray(v)) return fail(errs, at, 'expected array');
    const out: T[] = [];
    let ok = true;
    v.forEach((item, i) => {
      const r = check(item, `${at}[${i}]`, errs);
      if (r === undefined) ok = false;
      else out.push(r);
    });
    return ok ? out : undefined;
  };
}

const NO_OPTIONAL_KEYS: ReadonlySet<string> = new Set();

/** `optional` keys may be absent (older files); present values are still checked. */
function obj<T>(shape: Shape<T>, optional: ReadonlySet<string> = NO_OPTIONAL_KEYS): Check<T> {
  return (v, at, errs) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(errs, at, 'expected object');
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let ok = true;
    for (const key of Object.keys(shape) as (keyof T & string)[]) {
      if (src[key] === undefined && optional.has(key)) continue;
      const r = shape[key](src[key], `${at}.${key}`, errs);
      if (r === undefined) ok = false;
      else out[key] = r;
    }
    return ok ? (out as T) : undefined;
  };
}

function refine<T>(check: Check<T>, test: (v: T) => string | null): Check<T> {
  return (v, at, errs) => {
    const r = check(v, at, errs);
    if (r === undefined) return undefined;
    const problem = test(r);
    return problem === null ? r : fail(errs, at, problem);
  };
}

// ---------- Domain checks ----------

const uuid = matching(UUID_RE, 'a UUID');
const sha256Hex = hex(SHA256_HEX_LEN);
const hash16 = hex(HASH16_HEX_LEN);
const msTime = int(0);
const devPositive = int(1, MAX_DEV);
const counter = int(0, HLC_MAX_COUNTER);

const tbl: Check<Tbl> = (v, at, errs) =>
  typeof v === 'number' && TBL_VALUES.has(v) ? (v as Tbl) : fail(errs, at, 'expected a table number');

const regKey = obj<RegKey>({ tbl, rowId: nonEmptyString, reg: nonEmptyString });

const syncValue: Check<SyncValue> = (v, at, errs) => {
  if (isRecord(v) && typeof v[B64_KEY] === 'string') {
    const b64 = v[B64_KEY];
    if (Buffer.from(b64, 'base64').toString('base64') !== b64) return fail(errs, at, 'expected canonical base64');
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return fail(errs, at, 'expected finite number');
  try {
    return decodeValue(v);
  } catch {
    return fail(errs, at, 'expected an encoded value');
  }
};

const pmem = refine(obj<Pmem>({ ms: msTime, ids: arrayOf(hash16) }), (p) => {
  if (p.ids.length === 0) return 'pmem ids must not be empty';
  return p.ids.every((id, i) => i === 0 || p.ids[i - 1] < id) ? null : 'pmem ids must be sorted and unique';
});

const sibling = refine(
  obj<Sibling>({
    dev: int(0, MAX_DEV),
    ms: msTime,
    c: counter,
    pid: matching(new RegExp(`^([0-9a-f]{${HASH16_HEX_LEN}})?$`), 'empty or 32 lowercase hex chars'),
    lt: int(Number.MIN_SAFE_INTEGER),
    vhash: hash16,
    flags: int(0, MAX_FLAGS),
    value: syncValue,
    prevVhash: nullable(hex(PREV_HEX_LEN)),
  }),
  (s) => {
    if (s.dev === 0) return s.pid !== '' && s.c === 0 ? null : 'pseudo sibling needs a pid and c = 0';
    return s.pid === '' ? null : 'app sibling must have an empty pid';
  },
);

const identity = matching(IDENTITY_RE, 'an identity key');

const held = obj<HeldLegacyChange>(
  {
    key: regKey,
    kind: literal(['delete', 'stale-revert'] as const),
    sibling,
    replaces: nullable(identity),
    replacesEqual: arrayOf(identity),
    pmemAdd: pmem,
    sourceSha256: sha256Hex,
    heldAtMs: msTime,
  },
  new Set<keyof HeldLegacyChange>(['replacesEqual']),
);

const notice = obj<LocalNotice>({
  id: nonEmptyString,
  kind: literal(Object.keys(NOTICE_KINDS) as LocalNoticeKind[]),
  key: nullable(regKey),
  createdMs: msTime,
  sourceSha256: nullable(sha256Hex),
  count: int(0),
});

const binding = obj<FileBinding>({ sharedPath: nonEmptyString, realpath: nonEmptyString, fileId: uuid });

const sideFileTuple = obj<SideFileTuple>({
  name: literal(['wal', 'shm'] as const),
  exists: bool,
  size: int(0),
  mtimeMs: nonNegNumber,
});

const candidateLabels: Check<Readonly<Record<string, string>>> = (v, at, errs) => {
  if (!isRecord(v)) return fail(errs, at, 'expected object');
  const out: Record<string, string> = {};
  let ok = true;
  for (const [k, label] of Object.entries(v)) {
    const problem =
      !DEV_KEY_RE.test(k) || Number(k) > MAX_DEV
        ? 'key must be a decimal dev > 0'
        : typeof label !== 'string'
          ? 'expected string'
          : null;
    if (problem === null) {
      out[k] = label as string;
    } else {
      fail(errs, `${at}.${k}`, problem);
      ok = false;
    }
  }
  return ok ? out : undefined;
};

/** Keys added after the first local.json format; older files lack them. */
const LOCAL_JSON_OPTIONAL_KEYS: ReadonlySet<string> = new Set(['sideFilesConfirmedAtMs']);

const localJson = obj<LocalJson>({
  version: literal([LOCAL_JSON_VERSION] as const),
  lineageId: uuid,
  binding: nullable(binding),
  dev: devPositive,
  incarnation: hash16,
  lastMergedSha256: nullable(sha256Hex),
  lastPublished: nullable(
    obj<NonNullable<LocalJson['lastPublished']>>({
      sha256: sha256Hex,
      markerDot: obj({ dev: devPositive, ms: msTime, c: counter }),
    }),
  ),
  pendingPublish: bool,
  sideFiles: nullable(
    obj<NonNullable<LocalJson['sideFiles']>>({ tuples: arrayOf(sideFileTuple), confirmedAtMs: nullable(msTime) }),
  ),
  heldLegacy: arrayOf(held),
  snoozed: arrayOf(obj<SnoozeEntry>({ key: hash16, createdMs: msTime })),
  lastLimit: nullable(obj<NonNullable<LocalJson['lastLimit']>>({ value: int(UNLIMITED_LIMIT), atMs: msTime })),
  ignoredCopies: arrayOf(sha256Hex),
  abandonedWaits: arrayOf(nonEmptyString),
  notices: arrayOf(notice),
  candidateLabels,
  contentRepairShas: arrayOf(sha256Hex),
  sideFilesConfirmedAtMs: nullable(msTime),
}, LOCAL_JSON_OPTIONAL_KEYS);

/** Strict validation of parsed JSON (types, hex lengths, known notice kinds). */
export function validateLocalJson(raw: unknown): LocalJsonValidation {
  const errs: string[] = [];
  const value = localJson(raw, '$', errs);
  return value === undefined ? { ok: false, errors: errs } : { ok: true, value };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
