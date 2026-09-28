/**
 * Golden vector runner (spec 13.1): the reference consumer of __vectors__/*.json. Each case
 * names a function (`fn`), its JSON input and the expected JSON output; `runCase` recomputes
 * the output from the input with the TypeScript implementation. The Swift port implements the
 * same dispatch over the same files. Bytes are lowercase hex everywhere.
 */

import crypto from 'node:crypto';
import { canon, canonSecret, formatIsoMs, jcsFromText, parseLegacyTime, parseTimestamp } from '../canonical.js';
import { requireDef } from '../catalog.js';
import {
  accountHint,
  baseRefOf,
  deriveDev,
  deriveEpochKeys,
  deriveSubkey,
  deriveSyntheticDev,
  genesisIdOf,
  lineageIdFromSalt,
  makeImplicitProvider,
  pidOf,
  prevOf,
  rawHash,
  uuidV5,
  vaultIdFor,
  vhashOfSecret,
  vhashOfValue,
  vhashUndecryptable,
  vrefPlain,
  vrefSecret,
} from '../hashing.js';
import { HlcClock, maxReceivable, ownStamps, startHlc, tick } from '../hlc.js';
import { jcs } from '../jcs.js';
import { emptyState } from '../state-view.js';
import type { ContentRow, ContentTbl, Hlc, RegKey, Sibling, SqlValue, SyncState, SyncValue, Tbl } from '../types.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

export interface VectorCase {
  readonly name: string;
  readonly fn: string;
  readonly input: Json;
  readonly output: Json;
}

export interface VectorFile {
  readonly format: 1;
  readonly module: string;
  readonly notes: readonly string[];
  readonly cases: readonly VectorCase[];
}

export type CaseInput = Omit<VectorCase, 'output'>;

// ---------- Codecs ----------

/** A SyncValue or SQLite cell in JSON: null, number, string, or {"hex": bytes}. */
export type EncodedValue = null | number | string | { readonly hex: string };

/** A raw_hash cell: null, TEXT string, {"int": decimal} INTEGER, {"real": number} REAL, {"hex"} BLOB. */
export type EncodedCell = null | string | { readonly int: string } | { readonly real: number } | { readonly hex: string };

export const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (hex: string): Buffer => Buffer.from(hex, 'hex');

export function decodeValue(v: EncodedValue): SyncValue {
  return v !== null && typeof v === 'object' ? bytes(v.hex) : v;
}

export function encodeValue(v: SyncValue): EncodedValue {
  return v instanceof Uint8Array ? { hex: hexOf(v) } : v;
}

function decodeCell(cell: EncodedCell): SqlValue {
  if (cell === null || typeof cell === 'string') return cell;
  if ('int' in cell) {
    const n = BigInt(cell.int);
    return Number.isSafeInteger(Number(n)) ? Number(n) : n;
  }
  if ('real' in cell) return cell.real;
  return bytes(cell.hex);
}

interface KeyInput {
  readonly tbl: number;
  readonly rowId: string;
  readonly reg: string;
}

const keyOf = (i: KeyInput): RegKey => ({ tbl: i.tbl as Tbl, rowId: i.rowId, reg: i.reg });
const hlcJson = (h: Hlc | null): Json => (h === null ? null : { ms: h.ms, c: h.c });

type BaseRefInput = null | { readonly dev: number; readonly ms: number; readonly c: number } | { readonly pid: string };

function siblingForBaseRef(w: BaseRefInput): Sibling | null {
  if (w === null) return null;
  const common = { lt: 0, vhash: '0'.repeat(32), flags: 0, value: null, prevVhash: null };
  if ('pid' in w) return { dev: 0, ms: 0, c: 0, pid: w.pid, ...common };
  return { dev: w.dev, ms: w.ms, c: w.c, pid: '', ...common };
}

function stateOf(vv: ReadonlyArray<readonly [number, number, number]>, devs: ReadonlyArray<readonly [number, string]>): SyncState {
  return {
    ...emptyState('vectors', 'vectors', 0),
    vv: new Map(vv.map(([dev, ms, c]) => [dev, { ms, c }] as const)),
    devs: new Map(devs.map(([dev, deviceUuid]) => [dev, { dev, deviceUuid, startedMs: 0 }] as const)),
  };
}

// ---------- Runners ----------

/** null stands for "must be rejected" (NaN and infinities have no JSON form). */
function jcsOrNull(n: number): string | null {
  return Number.isFinite(n) ? jcs(n) : null;
}

type Runner = (input: never) => Json;

const canonRunners: Record<string, Runner> = {
  canon: (i: KeyInput & { value: EncodedValue }) => hexOf(canon(requireDef(keyOf(i)), decodeValue(i.value))),
  canonSecret: (i: { plaintext: string | null }) => hexOf(canonSecret(i.plaintext)),
  jcs: (i: { json: string }) => jcsFromText(i.json),
  jcsNumber: (i: { ieee754: string }) => jcsOrNull(bytes(i.ieee754).readDoubleBE(0)),
  parseTimestamp: (i: { text: string }) => {
    const ms = parseTimestamp(i.text);
    return { ms, iso: ms === null ? null : formatIsoMs(ms) };
  },
  formatIsoMs: (i: { ms: number }) => formatIsoMs(i.ms),
  parseLegacyTime: (i: { value: EncodedValue }) => parseLegacyTime(decodeValue(i.value)),
};

interface ReencryptInput {
  readonly kEpoch: string;
  readonly lineageId: string;
  readonly row: Readonly<Record<string, EncodedCell>>;
  readonly ciphertexts: readonly string[];
}

const hashingRunners: Record<string, Runner> = {
  vhashOfValue: (i: KeyInput & { value: EncodedValue }) => {
    const key = keyOf(i);
    const value = decodeValue(i.value);
    return { canon: hexOf(canon(requireDef(key), value)), vhash: vhashOfValue(key, value) };
  },
  vhashOfSecret: (i: KeyInput & { plaintext: string | null; kSync: string }) => ({
    canon: hexOf(canonSecret(i.plaintext)),
    vhash: vhashOfSecret(keyOf(i), i.plaintext, bytes(i.kSync)),
  }),
  vhashUndecryptable: (i: { ciphertext: string }) => vhashUndecryptable(bytes(i.ciphertext)),
  prevOf: (i: { vhash: string }) => prevOf(i.vhash),
  vrefPlain: (i: KeyInput & { value: EncodedValue }) => hexOf(vrefPlain(keyOf(i), decodeValue(i.value))),
  vrefSecret: (i: { ciphertext: string | null }) => hexOf(vrefSecret(i.ciphertext === null ? null : bytes(i.ciphertext))),
  baseRef: (i: { w: BaseRefInput }) => hexOf(baseRefOf(siblingForBaseRef(i.w))),
  pid: (i: KeyInput & { vref: string; baseRef: string; kPid: string }) =>
    pidOf(keyOf(i), bytes(i.vref), bytes(i.baseRef), bytes(i.kPid)),
  pidOfValue: (i: KeyInput & { value: EncodedValue; w: BaseRefInput; kPid: string }) => {
    const vref = vrefPlain(keyOf(i), decodeValue(i.value));
    const base = baseRefOf(siblingForBaseRef(i.w));
    return { vref: hexOf(vref), baseRef: hexOf(base), pid: pidOf(keyOf(i), vref, base, bytes(i.kPid)) };
  },
  pidOfSecret: (i: KeyInput & { ciphertext: string | null; w: BaseRefInput; kPid: string }) => {
    const vref = vrefSecret(i.ciphertext === null ? null : bytes(i.ciphertext));
    const base = baseRefOf(siblingForBaseRef(i.w));
    return { vref: hexOf(vref), baseRef: hexOf(base), pid: pidOf(keyOf(i), vref, base, bytes(i.kPid)) };
  },
  implicitSibling: (i: KeyInput & { kSync: string }) => {
    const s = makeImplicitProvider(bytes(i.kSync))(keyOf(i));
    return { dev: s.dev, ms: s.ms, c: s.c, pid: s.pid, lt: s.lt, vhash: s.vhash, value: encodeValue(s.value) };
  },
  rawHash: (i: { tbl: number; row: Readonly<Record<string, EncodedCell>> }) => rawHash(i.tbl as ContentTbl, rowOf(i.row)),
  rawHashReencrypt: (i: ReencryptInput) => rawHashReencrypt(i),
  hkdf: (i: { ikm: string; lineageId: string; info: string }) => hexOf(deriveSubkey(bytes(i.ikm), i.lineageId, i.info)),
  epochKeys: (i: { kEpoch: string; lineageId: string }) => {
    const k = deriveEpochKeys(bytes(i.kEpoch), i.lineageId);
    return { epochId: k.epochId, kSync: hexOf(k.kSync), kPid: hexOf(k.kPid) };
  },
  uuidV5: (i: { namespace: string; name: string }) => uuidV5(i.namespace, i.name),
  lineageIdFromSalt: (i: { salt: string }) => lineageIdFromSalt(i.salt),
  vaultIdFor: (i: { lineageId: string }) => vaultIdFor(i.lineageId),
  genesisId: (i: { bytes: string }) => genesisIdOf(bytes(i.bytes)),
  accountHint: (i: { lineageId: string; userId: string }) => accountHint(i.lineageId, i.userId),
  dev: (i: { deviceUuid: string; lineageId: string; incarnation: string }) => deriveDev(i.deviceUuid, i.lineageId, i.incarnation),
  devSyn: (i: { deviceUuid: string; random16: string }) => deriveSyntheticDev(i.deviceUuid, bytes(i.random16)),
};

function rowOf(cells: Readonly<Record<string, EncodedCell>>): ContentRow {
  return Object.fromEntries(Object.entries(cells).map(([col, cell]) => [col, decodeCell(cell)])) as unknown as ContentRow;
}

/** Same secret under two nonces: raw_hash differs, the keyed vhash of the opened plaintext does not. */
function rawHashReencrypt(i: ReencryptInput): Json {
  const keys = deriveEpochKeys(bytes(i.kEpoch), i.lineageId);
  const key: RegKey = { tbl: 1, rowId: String(decodeCell(i.row.id ?? null)), reg: 'password' };
  return i.ciphertexts.map((ct) => ({
    rawHash: rawHash(1, rowOf({ ...i.row, password_encrypted: { hex: ct } })),
    vhash: vhashOfSecret(key, openAesGcm(keys.kEpoch, bytes(ct)), keys.kSync),
  }));
}

type ClockOp = { readonly op: 'tick'; readonly now: number } | { readonly op: 'receive'; readonly seen: Hlc | null };

const hlcRunners: Record<string, Runner> = {
  tick: (i: { prev: Hlc; wallMs: number }) => hlcJson(tick(i.prev, i.wallMs)),
  startHlc: (i: { wallMs: number; own: readonly Hlc[] }) => hlcJson(startHlc(i.wallMs, i.own)),
  ownStamps: (i: { vv: Array<[number, number, number]>; devs: Array<[number, string]>; deviceUuid: string }) =>
    ownStamps(stateOf(i.vv, i.devs), i.deviceUuid).map(hlcJson),
  maxReceivable: (i: { wallMs: number; vv: Array<[number, number, number]>; ownDevs: number[] }) =>
    hlcJson(maxReceivable(stateOf(i.vv, []), i.wallMs, new Set(i.ownDevs))),
  clock: (i: { start: Hlc; script: readonly ClockOp[] }) => runClock(i.start, i.script),
};

function runClock(start: Hlc, script: readonly ClockOp[]): Json {
  let now = 0;
  const clock = new HlcClock(() => now, start);
  return script.map((step) => {
    if (step.op === 'tick') {
      now = step.now;
      return hlcJson(clock.tick());
    }
    clock.receive(step.seen);
    return hlcJson(clock.peek());
  });
}

const RUNNERS: Readonly<Record<string, Runner>> = { ...canonRunners, ...hashingRunners, ...hlcRunners };

export function runCase(c: CaseInput): Json {
  const runner = RUNNERS[c.fn];
  if (runner === undefined) throw new Error(`golden vectors: unknown fn ${c.fn}`);
  return runner(c.input as never);
}

export function buildFile(module: string, notes: readonly string[], inputs: readonly CaseInput[]): VectorFile {
  return { format: 1, module, notes, cases: inputs.map((c) => ({ ...c, output: runCase(c) })) };
}

const NON_ASCII = /[\u007f-\uffff]/g;

/** Pretty JSON, pure ASCII (non-ASCII as \uXXXX escapes) so editors cannot silently re-encode it. */
export function serializeFile(file: VectorFile): string {
  const text = JSON.stringify(file, null, 2).replace(NON_ASCII, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${text}\n`;
}

// ---------- AES-GCM for the re-encryption vector (nonce12 | ct | tag16, as vault/crypto.ts) ----------

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function sealAesGcm(key: Buffer, nonce: Buffer, plaintext: string): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

function openAesGcm(key: Buffer, blob: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, NONCE_LEN));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LEN));
  return Buffer.concat([decipher.update(blob.subarray(NONCE_LEN, blob.length - TAG_LEN)), decipher.final()]).toString('utf8');
}
