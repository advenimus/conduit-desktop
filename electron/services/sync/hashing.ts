/**
 * Every hash, key derivation and derived id of spec 3.1 and 3.6: vhash (unkeyed, keyed,
 * undecryptable), pid with vref/base_ref, prev_vhash, raw_hash, HKDF K_sync/K_pid, epoch_id
 * (key check value), lineage_id (UUIDv5), vault_id, genesis_id, account_hint, dev and dev_syn.
 * All outputs must match the Swift port byte for byte (13.1 golden vectors in
 * __vectors__/hashing.json, whose notes list the byte layouts).
 */

import crypto from 'node:crypto';
import { canon, canonSecret } from './canonical.js';
import { RAW_HASH_COLUMNS, implicitSiblingOf, requireDef } from './catalog.js';
import { HASH16_HEX_LEN, PREV_HEX_LEN, PSEUDO_DEV } from './types.js';
import type { ContentRow, ContentTbl, Dev, EpochKeys, ImplicitProvider, RegKey, Sibling, SyncValue } from './types.js';

/** Domain-separation labels, UTF-8 encoded where used. */
export const LABEL = {
  vhash: 'cvh1',
  vhashUndecryptable: 'cvhx',
  pid: 'cpid1',
  rawRow: 'crow1',
  hkdfVhash: 'conduit-sync-vhash-v1',
  hkdfPid: 'conduit-sync-pid-v1',
  epochId: 'conduit-epoch-id-v1',
  account: 'conduit-acct-v1',
  lineagePrefix: 'conduit-lineage:',
  vaultIdName: 'vault-id',
  candidateDev: 'cand',
} as const;

/** NS_CONDUIT of 3.1 (UUIDv5 namespace for lineage ids). Frozen forever. */
export const NS_CONDUIT = 'da5aafb2-40e7-4b0e-b2d4-cc828d8d30b7';

/** 0x1f unit separator between message fields. */
export const UNIT_SEP = 0x1f;

export const HKDF_KEY_LEN = 32;
export const TRUNC_LEN = 16;

/** base_ref leading bytes (4.3). */
export const BASE_REF_TAG = { none: 0x00, app: 0x01, pseudo: 0x02 } as const;

const HASH_ALG = 'sha256';
const UUID_HASH_ALG = 'sha1';
const SEP = String.fromCharCode(UNIT_SEP);
const DEV_BYTES = 6;
const MS_BYTES = 8;
const COUNTER_BYTES = 2;
const INCARNATION_BYTES = 16;
const SYNTHETIC_RANDOM_BYTES = 16;
const UUID_BYTES = 16;
const UUID_VERSION_BYTE = 6;
const UUID_VARIANT_BYTE = 8;
const UUID_V5_BITS = 0x50;
const UUID_VARIANT_BITS = 0x80;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]*$/i;
const UUID_GROUP_ENDS = [8, 12, 16, 20, 32] as const;
const EMPTY = Buffer.alloc(0);

// ---------- Primitives ----------

export function sha256(...parts: readonly Uint8Array[]): Buffer {
  const h = crypto.createHash(HASH_ALG);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** hex(trunc16(SHA-256(data))). */
function sha256Hex16(data: Uint8Array): string {
  return crypto.hash(HASH_ALG, data, 'hex').slice(0, HASH16_HEX_LEN);
}

/** hex(trunc16(HMAC-SHA256(key, data))). */
function hmacHex16(key: Uint8Array, data: Uint8Array): string {
  return crypto.createHmac(HASH_ALG, key).update(data).digest('hex').slice(0, HASH16_HEX_LEN);
}

/** Strict hex decoding: Buffer.from(hex) silently truncates bad input, so validate first. */
function hexBytes(hex: string, byteLen: number, what: string): Buffer {
  if (hex.length !== byteLen * 2 || !HEX_RE.test(hex)) {
    throw new Error(`hashing: ${what} must be ${byteLen * 2} hex characters`);
  }
  return Buffer.from(hex, 'hex');
}

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/** label 1f tbl 1f row_id 1f reg 1f, then `tail`. tbl is ASCII decimal. */
function registerMessage(label: string, key: RegKey, tail: Uint8Array): Buffer {
  const head = `${label}${SEP}${key.tbl}${SEP}${key.rowId}${SEP}${key.reg}${SEP}`;
  const headLen = Buffer.byteLength(head, 'utf8');
  const msg = Buffer.allocUnsafe(headLen + tail.length);
  msg.write(head, 0, 'utf8');
  msg.set(tail, headLen);
  return msg;
}

// ---------- Keys (3.6) ----------

/** HKDF-SHA256(ikm = kEpoch, salt = UTF-8(lineageId), info, L = 32). */
export function deriveSubkey(kEpoch: Buffer, lineageId: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync(HASH_ALG, kEpoch, utf8(lineageId), utf8(info), HKDF_KEY_LEN));
}

/** hex(trunc16(HMAC-SHA256(kEpoch, "conduit-epoch-id-v1"))). */
export function epochIdOf(kEpoch: Buffer): string {
  return hmacHex16(kEpoch, utf8(LABEL.epochId));
}

/** Builds EpochKeys (epochId, kEpoch, kSync, kPid) for one epoch key. */
export function deriveEpochKeys(kEpoch: Buffer, lineageId: string): EpochKeys {
  return {
    epochId: epochIdOf(kEpoch),
    kEpoch,
    kSync: deriveSubkey(kEpoch, lineageId, LABEL.hkdfVhash),
    kPid: deriveSubkey(kEpoch, lineageId, LABEL.hkdfPid),
  };
}

// ---------- vhash ----------

/** Unkeyed vhash: hex(trunc16(SHA-256("cvh1" 1f tbl 1f row_id 1f reg 1f canonBytes))). */
export function vhashPlain(key: RegKey, canonBytes: Uint8Array): string {
  return sha256Hex16(registerMessage(LABEL.vhash, key, canonBytes));
}

/** Keyed vhash for secrets: hex(trunc16(HMAC-SHA256(kSync, same message as vhashPlain))). */
export function vhashKeyed(key: RegKey, canonBytes: Uint8Array, kSync: Buffer): string {
  return hmacHex16(kSync, registerMessage(LABEL.vhash, key, canonBytes));
}

/** Undecryptable secret sibling: hex(trunc16(SHA-256("cvhx" || ciphertext))). */
export function vhashUndecryptable(ciphertext: Uint8Array): string {
  return sha256Hex16(Buffer.concat([utf8(LABEL.vhashUndecryptable), ciphertext]));
}

/** vhashPlain(key, canon(def, value)) for a non-secret register. Throws for secrets. */
export function vhashOfValue(key: RegKey, value: SyncValue): string {
  return vhashPlain(key, canon(requireDef(key), value));
}

/** vhashKeyed(key, canonSecret(plaintext), kSync) for a secret register. */
export function vhashOfSecret(key: RegKey, plaintext: string | null, kSync: Buffer): string {
  return vhashKeyed(key, canonSecret(plaintext), kSync);
}

/** prev_vhash: the first 8 bytes (16 hex chars) of a vhash. */
export function prevOf(vhash: string): string {
  if (vhash.length !== HASH16_HEX_LEN) throw new Error('hashing: prevOf needs a 32-hex vhash');
  return vhash.slice(0, PREV_HEX_LEN);
}

// ---------- pid (3.6, 4.3) ----------

/** vref of a non-secret value: the 16 raw bytes of its unkeyed vhash. */
export function vrefPlain(key: RegKey, value: SyncValue): Buffer {
  return Buffer.from(vhashOfValue(key, value), 'hex');
}

/** vref of a secret: SHA-256 of the STORED ciphertext (32 bytes); NULL hashes the empty string. */
export function vrefSecret(ciphertext: Uint8Array | null): Buffer {
  return sha256(ciphertext ?? EMPTY);
}

function appBaseRef(w: Sibling): Buffer {
  const out = Buffer.alloc(1 + DEV_BYTES + MS_BYTES + COUNTER_BYTES);
  out[0] = BASE_REF_TAG.app;
  out.writeUIntBE(w.dev, 1, DEV_BYTES);
  out.writeBigUInt64BE(BigInt(w.ms), 1 + DEV_BYTES);
  out.writeUInt16BE(w.c, 1 + DEV_BYTES + MS_BYTES);
  return out;
}

/** base_ref of 4.3: 0x01||dev(6 BE)||ms(8 BE)||c(2 BE) for app w; 0x02||pid(16) for pseudo w; 0x00 for none. */
export function baseRefOf(w: Sibling | null): Buffer {
  if (w === null) return Buffer.of(BASE_REF_TAG.none);
  if (w.dev !== PSEUDO_DEV) return appBaseRef(w);
  return Buffer.concat([Buffer.of(BASE_REF_TAG.pseudo), hexBytes(w.pid, TRUNC_LEN, 'pid')]);
}

/** pid: hex(trunc16(HMAC-SHA256(kPid, "cpid1" 1f tbl 1f row_id 1f reg 1f vref 1f base_ref))). */
export function pidOf(key: RegKey, vref: Uint8Array, baseRef: Uint8Array, kPid: Buffer): string {
  const tail = Buffer.allocUnsafe(vref.length + 1 + baseRef.length);
  tail.set(vref, 0);
  tail[vref.length] = UNIT_SEP;
  tail.set(baseRef, vref.length + 1);
  return hmacHex16(kPid, registerMessage(LABEL.pid, key, tail));
}

// ---------- raw_hash ----------

/** raw_hash cell tags (SQLite storage classes). */
export const RAW_TAG = { null: 0, integer: 1, real: 2, text: 3, blob: 4 } as const;

const RAW_PREFIX = utf8(LABEL.rawRow);
const CELL_HEADER_LEN = 1 + 4;
const NUMBER_LEN = 8;
const INT64_MIN = -(2 ** 63);
const INT64_LIMIT = 2 ** 63;

type Cell = null | number | bigint | string | Uint8Array;

function isInt64Number(v: number): boolean {
  return Number.isInteger(v) && v >= INT64_MIN && v < INT64_LIMIT;
}

function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  throw new Error(`hashing: raw_hash cannot encode a ${typeof v} cell`);
}

function cellTag(v: Cell): number {
  if (v === null) return RAW_TAG.null;
  if (typeof v === 'bigint') return RAW_TAG.integer;
  if (typeof v === 'number') return isInt64Number(v) ? RAW_TAG.integer : RAW_TAG.real;
  return typeof v === 'string' ? RAW_TAG.text : RAW_TAG.blob;
}

function cellLength(v: Cell): number {
  if (v === null) return 0;
  if (typeof v === 'number' || typeof v === 'bigint') return NUMBER_LEN;
  return typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : v.length;
}

/** Writes tag, u32 BE length and the stored bytes; returns the next offset. */
function writeCell(buf: Buffer, offset: number, v: Cell, len: number): number {
  const tag = cellTag(v);
  buf[offset] = tag;
  buf.writeUInt32BE(len, offset + 1);
  const at = offset + CELL_HEADER_LEN;
  if (tag === RAW_TAG.integer) buf.writeBigInt64BE(BigInt(v as number | bigint), at);
  else if (tag === RAW_TAG.real) buf.writeDoubleBE(v as number, at);
  else if (tag === RAW_TAG.text) buf.write(v as string, at, 'utf8');
  else if (tag === RAW_TAG.blob) buf.set(v as Uint8Array, at);
  return at + len;
}

/**
 * raw_hash over STORED column bytes of RAW_HASH_COLUMNS (catalog.ts); never over plaintext:
 * hex(trunc16(SHA-256("crow1" || per column: tag byte, u32 BE length, bytes))). INTEGER is
 * 8-byte BE two's complement (an integral number within int64, or a bigint), REAL 8-byte
 * IEEE-754 BE, TEXT UTF-8, BLOB raw, NULL (or a missing column) length 0.
 */
export function rawHash(tbl: ContentTbl, row: ContentRow): string {
  const record = row as unknown as Readonly<Record<string, unknown>>;
  const cells = RAW_HASH_COLUMNS[tbl].map((col) => cellOf(record[col]));
  const lengths = cells.map(cellLength);
  let size = RAW_PREFIX.length;
  for (const len of lengths) size += CELL_HEADER_LEN + len;
  const buf = Buffer.allocUnsafe(size);
  let offset = RAW_PREFIX.copy(buf, 0);
  cells.forEach((cell, i) => {
    offset = writeCell(buf, offset, cell, lengths[i]);
  });
  return sha256Hex16(buf);
}

// ---------- Ids (3.1) ----------

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  const groups: string[] = [];
  let start = 0;
  for (const end of UUID_GROUP_ENDS) {
    groups.push(hex.slice(start, end));
    start = end;
  }
  return groups.join('-');
}

function uuidBytes(uuid: string): Buffer {
  if (!UUID_RE.test(uuid)) throw new Error('hashing: namespace is not a UUID');
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** RFC 4122 version-5 UUID (SHA-1), lowercase. */
export function uuidV5(namespace: string, name: string): string {
  const digest = crypto.createHash(UUID_HASH_ALG).update(uuidBytes(namespace)).update(utf8(name)).digest();
  const bytes = Buffer.from(digest.subarray(0, UUID_BYTES));
  bytes[UUID_VERSION_BYTE] = (bytes[UUID_VERSION_BYTE] & 0x0f) | UUID_V5_BITS;
  bytes[UUID_VARIANT_BYTE] = (bytes[UUID_VARIANT_BYTE] & 0x3f) | UUID_VARIANT_BITS;
  return formatUuid(bytes);
}

/** lineage_id of a legacy file: UUIDv5(NS_CONDUIT, "conduit-lineage:" + vault_meta.salt text). */
export function lineageIdFromSalt(salt: string): string {
  return uuidV5(NS_CONDUIT, LABEL.lineagePrefix + salt);
}

/** vault_id for a legacy file without one: UUIDv5(lineageId, "vault-id"). */
export function vaultIdFor(lineageId: string): string {
  return uuidV5(lineageId, LABEL.vaultIdName);
}

/** genesis_id: lowercase hex SHA-256 (64 chars) of the pre-sync file bytes. */
export function genesisIdOf(fileBytes: Uint8Array): string {
  return crypto.hash(HASH_ALG, fileBytes, 'hex');
}

/** account_hint: hex(trunc16(SHA-256("conduit-acct-v1" || lineage_id || user_id))), UTF-8, no separators. */
export function accountHint(lineageId: string, userId: string): string {
  return sha256(utf8(LABEL.account), utf8(lineageId), utf8(userId)).subarray(0, TRUNC_LEN).toString('hex');
}

/** First 48 bits (BE) of a digest; 0 is reserved for pseudo dots and maps to 1. */
function devFromDigest(digest: Buffer): Dev {
  const dev = digest.readUIntBE(0, DEV_BYTES);
  return dev === PSEUDO_DEV ? 1 : dev;
}

/** dev: first 48 bits (BE) of SHA-256(UTF-8 device_uuid || UTF-8 lineage_id || 16 incarnation bytes); 0 -> 1. */
export function deriveDev(deviceUuid: string, lineageId: string, incarnationHex: string): Dev {
  const incarnation = hexBytes(incarnationHex, INCARNATION_BYTES, 'incarnation');
  return devFromDigest(sha256(utf8(deviceUuid), utf8(lineageId), incarnation));
}

/** dev_syn (4.9): first 48 bits of SHA-256("cand" || UTF-8 device_uuid || random16); 0 -> 1. */
export function deriveSyntheticDev(deviceUuid: string, random16: Uint8Array): Dev {
  if (random16.length !== SYNTHETIC_RANDOM_BYTES) throw new Error('hashing: dev_syn needs 16 random bytes');
  return devFromDigest(sha256(utf8(LABEL.candidateDev), utf8(deviceUuid), random16));
}

// ---------- Implicit siblings (3.4) ----------

/** ImplicitProvider for the current epoch: implicitSiblingOf(key, vhash of the catalog default). */
export function makeImplicitProvider(kSync: Buffer): ImplicitProvider {
  return (key: RegKey): Sibling => {
    const def = requireDef(key);
    const vhash = def.secret
      ? vhashKeyed(key, canonSecret(null), kSync)
      : vhashPlain(key, canon(def, def.defaultValue));
    return implicitSiblingOf(key, vhash);
  };
}
