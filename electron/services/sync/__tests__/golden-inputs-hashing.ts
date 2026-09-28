/**
 * Fixed inputs of the hashing golden vectors (spec 13.1, __vectors__/hashing.json). See
 * golden-inputs.ts for how the files are built and checked.
 */

import { RAW_HASH_COLUMNS } from '../catalog.js';
import { deriveEpochKeys } from '../hashing.js';
import { HLC_MAX_COUNTER, ZERO_PID } from '../types.js';
import { ASCII_NOTE, E, F, H, M, S, WALL, kv, named } from './golden-inputs.js';
import { hexOf, sealAesGcm, type CaseInput, type EncodedCell, type EncodedValue } from './golden-run.js';

const K_EPOCH = Buffer.from([...Array(32).keys()]);
const K_EPOCH_2 = Buffer.alloc(32, 0xa5);
const LINEAGE = '3b241101-e2bb-4255-8caf-4136c566a962';
const KEYS = deriveEpochKeys(K_EPOCH, LINEAGE);
const K_SYNC = hexOf(KEYS.kSync);
const K_PID = hexOf(KEYS.kPid);
const NS_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NS_CONDUIT = 'da5aafb2-40e7-4b0e-b2d4-cc828d8d30b7';
const CT_A = hexOf(sealAesGcm(K_EPOCH, Buffer.alloc(12, 0x11), 'hunter2'));
const CT_B = hexOf(sealAesGcm(K_EPOCH, Buffer.alloc(12, 0x22), 'hunter2'));

export const HASHING_NOTES: readonly string[] = [
  ASCII_NOTE,
  'Byte layouts of spec 3.1 and 3.6 (hashing.ts). Separator 0x1f; tbl as ASCII decimal; strings UTF-8; trunc16 = first 16 bytes; hex lowercase.',
  'kSync/kPid inputs are the HKDF outputs of the epochKeys case for kEpoch 000102..1f and the lineage in these vectors.',
  'baseRef input w: null (none), {dev, ms, c} (app: 0x01, dev 6 bytes BE, ms 8 bytes BE, c 2 bytes BE) or {pid} (pseudo: 0x02, pid 16 bytes).',
  'rawHash cells: null NULL, string TEXT, {"int": decimal} INTEGER (8-byte BE two\'s complement), {"real": number} REAL (8-byte IEEE-754 BE), {"hex"} BLOB. Missing columns are NULL. id and updated_at are not hashed.',
  ...([E, F, H] as const).map((tbl) => `rawHash column order, tbl ${tbl}: ${RAW_HASH_COLUMNS[tbl].join(', ')}`),
  'Desktop reads SQLite REAL values with an integral value as JS integers, so it hashes them as INTEGER; a Swift reader that keeps REAL would differ for such cells, which costs only a re-compare (spec 3.6).',
  'rawHashReencrypt: two AES-256-GCM ciphertexts (nonce12 | ct | tag16 under kEpoch) of one secret: raw_hash differs, the keyed vhash of the decrypted plaintext is equal. No plaintext is an input.',
  'dev and devSyn outputs are JSON numbers below 2^48.',
];

const ENTRY_ROW: Readonly<Record<string, EncodedCell>> = {
  id: 'e1',
  name: 'Prod database',
  entry_type: 'ssh',
  folder_id: 'f1',
  parent_entry_id: null,
  sort_order: { int: '3' },
  host: 'db.example.com',
  port: { int: '22' },
  credential_id: null,
  username: 'root',
  password_encrypted: { hex: CT_A },
  domain: '',
  private_key_encrypted: null,
  totp_secret_encrypted: null,
  icon: null,
  color: '#ff0000',
  credential_type: null,
  config: '{"a":1}',
  tags: '["prod"]',
  is_favorite: { int: '1' },
  notes: 'café 🔑',
  created_at: '2025-01-02T03:04:05.678Z',
  updated_at: '2025-01-03T00:00:00.000Z',
};

function vhashCases(): CaseInput[] {
  const v = (name: string, tbl: number, rowId: string, reg: string, value: EncodedValue): CaseInput =>
    named('vhashOfValue', name, kv(tbl, rowId, reg, value));
  const sec = (name: string, tbl: number, rowId: string, reg: string, plaintext: string | null): CaseInput =>
    named('vhashOfSecret', name, { tbl, rowId, reg, plaintext, kSync: K_SYNC });
  return [
    v('host', E, 'e1', 'host', 'db.example.com'),
    v('host empty string equals null', E, 'e1', 'host', ''),
    v('host null', E, 'e1', 'host', null),
    v('same host, other row', E, 'e2', 'host', 'db.example.com'),
    v('port integer', E, 'e1', 'port', 22),
    v('port integer text equals integer', E, 'e1', 'port', '22'),
    v('name empty string', E, 'e1', 'name', ''),
    v('_life live', E, 'e1', '_life', 'live'),
    v('_life dead', E, 'e1', '_life', 'dead'),
    v('container', E, 'e1', 'container', 'f:f1'),
    v('config JSON', E, 'e1', 'config.rdp', '{"b":2,"a":1}'),
    v('tag', E, 'e1', 'tag:prod', 1),
    v('created_at GRDB', E, 'e1', 'created_at', '2025-01-02 03:04:05.678'),
    v('created_at ISO equals GRDB', E, 'e1', 'created_at', '2025-01-02T03:04:05.678Z'),
    v('unicode row id', E, 'é-row', 'name', 'x'),
    v('folder name', F, 'f1', 'name', 'Servers'),
    v('history changed_by', H, 'h1', 'changed_by', 'conflict'),
    v('meta vault_id', M, 'meta', 'vault_id', '0d9f7c2e-5b1a-4c3d-8e9f-a0b1c2d3e4f5'),
    v('_sync epoch', S, 'key', 'epoch', KEYS.epochId),
    sec('password', E, 'e1', 'password', 'hunter2'),
    sec('password null', E, 'e1', 'password', null),
    sec('password empty equals null', E, 'e1', 'password', ''),
    sec('same password, other row', E, 'e2', 'password', 'hunter2'),
    sec('private key', E, 'e1', 'private_key', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n'),
    sec('history password', H, 'h1', 'password', 'hunter2'),
    named('vhashUndecryptable', 'ciphertext', { ciphertext: CT_A }),
    named('prevOf', 'first 8 bytes', { vhash: '0123456789abcdeffedcba9876543210' }),
  ];
}

function pidCases(): CaseInput[] {
  const app = { dev: 0x0102030405, ms: 0x1122334455, c: 0x0a0b };
  const pseudo = { pid: 'ff'.repeat(16) };
  const implicit = { pid: ZERO_PID };
  const key = { tbl: E, rowId: 'e1', reg: 'host' };
  const pw = { tbl: E, rowId: 'e1', reg: 'password' };
  return [
    named('vrefPlain', 'host', kv(E, 'e1', 'host', 'db.example.com')),
    named('vrefSecret', 'ciphertext', { ciphertext: CT_A }),
    named('vrefSecret', 'null hashes the empty string', { ciphertext: null }),
    named('baseRef', 'none', { w: null }),
    named('baseRef', 'app', { w: app }),
    named('baseRef', 'app maxima', { w: { dev: 2 ** 48 - 1, ms: WALL, c: HLC_MAX_COUNTER } }),
    named('baseRef', 'pseudo', { w: pseudo }),
    named('baseRef', 'implicit sibling (zero pid)', { w: implicit }),
    named('pid', 'raw inputs', { ...key, vref: '00'.repeat(16), baseRef: '00', kPid: K_PID }),
    named('pidOfValue', 'genesis (no base)', { ...key, value: 'db.example.com', w: null, kPid: K_PID }),
    named('pidOfValue', 'replacing an app sibling', { ...key, value: 'db.example.com', w: app, kPid: K_PID }),
    named('pidOfValue', 'replacing a pseudo sibling', { ...key, value: 'db.example.com', w: pseudo, kPid: K_PID }),
    named('pidOfValue', 'replacing the implicit sibling', { ...key, value: 'db.example.com', w: implicit, kPid: K_PID }),
    named('pidOfValue', 'null value', { ...key, value: null, w: null, kPid: K_PID }),
    named('pidOfSecret', 'ciphertext-based vref', { ...pw, ciphertext: CT_A, w: null, kPid: K_PID }),
    named('pidOfSecret', 'other nonce, other pid', { ...pw, ciphertext: CT_B, w: null, kPid: K_PID }),
    named('pidOfSecret', 'null secret', { ...pw, ciphertext: null, w: app, kPid: K_PID }),
  ];
}

function implicitCases(): CaseInput[] {
  const regs: ReadonlyArray<readonly [number, string, string]> = [
    [E, 'e1', '_life'], [E, 'e1', 'name'], [E, 'e1', 'host'], [E, 'e1', 'port'], [E, 'e1', 'sort_order'],
    [E, 'e1', 'container'], [E, 'e1', 'config.rdp'], [E, 'e1', 'tag:prod'], [E, 'e1', 'created_at'],
    [E, 'e1', 'password'], [F, 'f1', 'container'], [H, 'h1', 'password'], [M, 'meta', 'vault_id'],
  ];
  return regs.map(([tbl, rowId, reg]) => named('implicitSibling', `${tbl}/${rowId}/${reg}`, { tbl, rowId, reg, kSync: K_SYNC }));
}

function rawHashCases(): CaseInput[] {
  return [
    named('rawHash', 'entry', { tbl: E, row: ENTRY_ROW }),
    named('rawHash', 'entry: updated_at and id not hashed', { tbl: E, row: { ...ENTRY_ROW, id: 'other', updated_at: 'x' } }),
    named('rawHash', 'entry: TEXT port differs from INTEGER', { tbl: E, row: { ...ENTRY_ROW, port: '22' } }),
    named('rawHash', 'entry: REAL port', { tbl: E, row: { ...ENTRY_ROW, port: { real: 22.5 } } }),
    named('rawHash', 'entry: 64-bit integer', { tbl: E, row: { ...ENTRY_ROW, sort_order: { int: '-9223372036854775808' } } }),
    named('rawHash', 'entry: empty string differs from NULL', { tbl: E, row: { ...ENTRY_ROW, domain: null } }),
    named('rawHash', 'folder', { tbl: F, row: { id: 'f1', name: 'Servers', parent_id: null, sort_order: { int: '0' }, icon: '', color: null, created_at: '2025-01-02 03:04:05', updated_at: 'ignored' } }),
    named('rawHash', 'history', { tbl: H, row: { id: 'h1', entry_id: 'e1', username: 'root', password_encrypted: { hex: CT_B }, changed_at: '2025-01-02T03:04:05.678Z', changed_by: null } }),
    named('rawHash', 'history: missing columns are NULL', { tbl: H, row: { id: 'h1', entry_id: 'e1' } }),
    named('rawHashReencrypt', 're-encrypted password', { kEpoch: hexOf(K_EPOCH), lineageId: LINEAGE, row: ENTRY_ROW, ciphertexts: [CT_A, CT_B] }),
  ];
}

function idCases(): CaseInput[] {
  const inc1 = '00112233445566778899aabbccddeeff';
  const inc2 = 'ffeeddccbbaa99887766554433221100';
  return [
    named('hkdf', 'RFC 5869 case 3 (first 32 bytes)', { ikm: '0b'.repeat(22), lineageId: '', info: '' }),
    named('hkdf', 'vhash key', { ikm: hexOf(K_EPOCH), lineageId: LINEAGE, info: 'conduit-sync-vhash-v1' }),
    named('hkdf', 'pid key', { ikm: hexOf(K_EPOCH), lineageId: LINEAGE, info: 'conduit-sync-pid-v1' }),
    named('epochKeys', 'kEpoch 00..1f', { kEpoch: hexOf(K_EPOCH), lineageId: LINEAGE }),
    named('epochKeys', 'kEpoch a5..a5', { kEpoch: hexOf(K_EPOCH_2), lineageId: LINEAGE }),
    named('uuidV5', 'RFC 4122 DNS example', { namespace: NS_DNS, name: 'www.example.com' }),
    named('uuidV5', 'uppercase namespace', { namespace: NS_DNS.toUpperCase(), name: 'www.example.com' }),
    named('uuidV5', 'NS_CONDUIT unicode name', { namespace: NS_CONDUIT, name: 'näme 🔑' }),
    named('lineageIdFromSalt', 'base64 salt', { salt: 'c2FsdHNhbHRzYWx0c2FsdA==' }),
    named('lineageIdFromSalt', 'empty salt', { salt: '' }),
    named('vaultIdFor', 'lineage', { lineageId: LINEAGE }),
    named('genesisId', 'empty file', { bytes: '' }),
    named('genesisId', 'abc', { bytes: '616263' }),
    named('genesisId', 'SQLite header', { bytes: Buffer.from('SQLite format 3\0', 'latin1').toString('hex') }),
    named('accountHint', 'signed in', { lineageId: LINEAGE, userId: 'b5e7c1d2-3a4f-4e5d-9c8b-7a6f5e4d3c2b' }),
    named('accountHint', 'empty user id', { lineageId: LINEAGE, userId: '' }),
    named('dev', 'incarnation 1', { deviceUuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', lineageId: LINEAGE, incarnation: inc1 }),
    named('dev', 'incarnation 2', { deviceUuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', lineageId: LINEAGE, incarnation: inc2 }),
    named('dev', 'other device', { deviceUuid: '16fd2706-8baf-433b-82eb-8c7fada847da', lineageId: LINEAGE, incarnation: inc1 }),
    named('devSyn', 'random 1', { deviceUuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', random16: inc1 }),
    named('devSyn', 'random 2', { deviceUuid: '7c9e6679-7425-40de-944b-e07fc1f90ae7', random16: inc2 }),
  ];
}

export function hashingInputs(): CaseInput[] {
  return [...vhashCases(), ...pidCases(), ...implicitCases(), ...rawHashCases(), ...idCases()];
}
