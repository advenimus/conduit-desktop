// @vitest-environment node
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canon, canonSecret } from '../canonical.js';
import { configReg, fixedRegisters, regKey, requireDef } from '../catalog.js';
import {
  accountHint,
  baseRefOf,
  deriveDev,
  deriveEpochKeys,
  deriveSubkey,
  deriveSyntheticDev,
  epochIdOf,
  genesisIdOf,
  lineageIdFromSalt,
  makeImplicitProvider,
  pidOf,
  prevOf,
  rawHash,
  sha256,
  uuidV5,
  vaultIdFor,
  vhashKeyed,
  vhashOfSecret,
  vhashOfValue,
  vhashPlain,
  vhashUndecryptable,
  vrefPlain,
  vrefSecret,
} from '../hashing.js';
import { TBL, ZERO_PID, type EntryRow, type FolderRow, type HistoryRow, type RegKey, type Sibling } from '../types.js';

const KEY32 = Buffer.from([...Array(32).keys()]);
const LINEAGE = '6f1c1a52-3f0e-5a55-8e2b-0c1d2e3f4a5b';
const host: RegKey = regKey(TBL.entries, 'e1', 'host');
const password: RegKey = regKey(TBL.entries, 'e1', 'password');
const trunc16Hex = (b: Buffer): string => b.subarray(0, 16).toString('hex');
const message = (label: string, key: RegKey, tail: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${label}\x1f${key.tbl}\x1f${key.rowId}\x1f${key.reg}\x1f`, 'utf8'), tail]);

function app(dev: number, ms: number, c: number): Sibling {
  return { dev, ms, c, pid: '', lt: 0, vhash: 'ab'.repeat(16), flags: 0, value: 'x', prevVhash: null };
}

function aesGcm(key: Buffer, nonce: Buffer, plaintext: string): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]);
}

function openGcm(key: Buffer, blob: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]).toString('utf8');
}

function entryRow(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 'e1', name: 'Prod', entry_type: 'ssh', folder_id: null, parent_entry_id: null, sort_order: 0,
    host: 'db.example.com', port: 22, credential_id: null, username: 'root', password_encrypted: null,
    domain: null, private_key_encrypted: null, totp_secret_encrypted: null, icon: null, color: null,
    credential_type: null, config: '{}', tags: '[]', is_favorite: 0, notes: null,
    created_at: '2025-01-02T03:04:05.678Z', updated_at: '2025-01-02T03:04:05.678Z', ...overrides,
  };
}

describe('primitives and keys', () => {
  it('hashes multi-part input like the concatenation', () => {
    const a = Buffer.from('ab');
    const b = Buffer.from('c');
    expect(sha256(a, b).equals(crypto.createHash('sha256').update('abc').digest())).toBe(true);
  });

  it('matches RFC 5869 test case 3 (empty salt and info; first 32 bytes)', () => {
    const okm = deriveSubkey(Buffer.alloc(22, 0x0b), '', '');
    expect(okm.toString('hex')).toBe('8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d');
  });

  it('derives epoch keys: key check value, distinct subkeys per label and lineage', () => {
    const k = deriveEpochKeys(KEY32, LINEAGE);
    expect(k.epochId).toBe(trunc16Hex(crypto.createHmac('sha256', KEY32).update('conduit-epoch-id-v1').digest()));
    expect(k.epochId).toBe(epochIdOf(KEY32));
    expect(k.kEpoch).toBe(KEY32);
    expect(k.kSync.length).toBe(32);
    expect(k.kSync.equals(k.kPid)).toBe(false);
    expect(k.kSync.equals(Buffer.from(crypto.hkdfSync('sha256', KEY32, LINEAGE, 'conduit-sync-vhash-v1', 32)))).toBe(true);
    expect(deriveEpochKeys(KEY32, 'other').kSync.equals(k.kSync)).toBe(false);
  });
});

describe('vhash', () => {
  it('hashes "cvh1" 1f tbl 1f row_id 1f reg 1f canon, truncated to 16 bytes', () => {
    const c = canon(requireDef(host), 'db.example.com');
    const expected = trunc16Hex(crypto.createHash('sha256').update(message('cvh1', host, c)).digest());
    expect(vhashPlain(host, c)).toBe(expected);
    expect(vhashOfValue(host, 'db.example.com')).toBe(expected);
  });

  it('is canonical: equal canon values hash equally, and the key scopes the hash', () => {
    const port = regKey(TBL.entries, 'e1', 'port');
    expect(vhashOfValue(port, '22')).toBe(vhashOfValue(port, 22));
    expect(vhashOfValue(host, '')).toBe(vhashOfValue(host, null));
    expect(vhashOfValue(regKey(TBL.entries, 'e2', 'host'), 'x')).not.toBe(vhashOfValue(host, 'x'));
    expect(vhashOfValue(regKey(TBL.entries, 'e1', configReg('a')), '{"b":1,"a":2}')).toBe(
      vhashOfValue(regKey(TBL.entries, 'e1', configReg('a')), '{"a":2,"b":1}'),
    );
  });

  it('refuses secrets in the unkeyed form', () => {
    expect(() => vhashOfValue(password, null)).toThrow(/secret/);
  });

  it('keys secret hashes with HMAC over the same message and scopes them by row', () => {
    const kSync = deriveEpochKeys(KEY32, LINEAGE).kSync;
    const expected = trunc16Hex(crypto.createHmac('sha256', kSync).update(message('cvh1', password, canonSecret('hunter2'))).digest());
    expect(vhashKeyed(password, canonSecret('hunter2'), kSync)).toBe(expected);
    expect(vhashOfSecret(password, 'hunter2', kSync)).toBe(expected);
    expect(vhashOfSecret(regKey(TBL.entries, 'e2', 'password'), 'hunter2', kSync)).not.toBe(expected);
    expect(vhashOfSecret(password, 'hunter2', deriveEpochKeys(KEY32, 'x').kSync)).not.toBe(expected);
    expect(vhashOfSecret(password, '', kSync)).toBe(vhashOfSecret(password, null, kSync));
  });

  it('hashes undecryptable ciphertext as "cvhx" || ct without separators', () => {
    const ct = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const expected = trunc16Hex(crypto.createHash('sha256').update(Buffer.concat([Buffer.from('cvhx'), ct])).digest());
    expect(vhashUndecryptable(ct)).toBe(expected);
  });

  it('takes the first 8 bytes as prev_vhash', () => {
    expect(prevOf('0123456789abcdef'.repeat(2))).toBe('0123456789abcdef');
    expect(() => prevOf('abc')).toThrow();
  });
});

describe('pid, vref and base_ref', () => {
  it('uses the raw unkeyed vhash as the non-secret vref', () => {
    expect(vrefPlain(host, 'x').toString('hex')).toBe(vhashOfValue(host, 'x'));
  });

  it('hashes the stored ciphertext (or nothing) as the secret vref', () => {
    expect(vrefSecret(null).toString('hex')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(vrefSecret(Buffer.from('abc')).length).toBe(32);
  });

  it('lays out base_ref for none, app and pseudo siblings', () => {
    expect(baseRefOf(null).toString('hex')).toBe('00');
    expect(baseRefOf(app(0x0102030405, 0x1122334455, 0x0a0b)).toString('hex')).toBe(
      '01' + '000102030405' + '0000001122334455' + '0a0b',
    );
    const pseudo: Sibling = { ...app(0, 7, 0), pid: 'ff'.repeat(16) };
    expect(baseRefOf(pseudo).toString('hex')).toBe('02' + 'ff'.repeat(16));
    expect(baseRefOf({ ...pseudo, pid: ZERO_PID }).toString('hex')).toBe('02' + '00'.repeat(16));
  });

  it('rejects malformed base_ref inputs', () => {
    expect(() => baseRefOf({ ...app(0, 1, 0), pid: 'zz'.repeat(16) })).toThrow();
    expect(() => baseRefOf(app(2 ** 48, 1, 0))).toThrow();
    expect(() => baseRefOf(app(1, -1, 0))).toThrow();
    expect(() => baseRefOf(app(1, 1, 65536))).toThrow();
  });

  it('keys the pid over "cpid1" 1f tbl 1f row_id 1f reg 1f vref 1f base_ref', () => {
    const kPid = deriveEpochKeys(KEY32, LINEAGE).kPid;
    const vref = vrefPlain(host, 'x');
    const base = baseRefOf(null);
    const tail = Buffer.concat([vref, Buffer.of(0x1f), base]);
    const expected = trunc16Hex(crypto.createHmac('sha256', kPid).update(message('cpid1', host, tail)).digest());
    expect(pidOf(host, vref, base, kPid)).toBe(expected);
    expect(pidOf(host, vref, baseRefOf(app(1, 2, 3)), kPid)).not.toBe(expected);
    expect(pidOf(host, vref, base, deriveEpochKeys(KEY32, 'x').kPid)).not.toBe(expected);
  });
});

describe('rawHash', () => {
  it('hashes tag, u32 length and stored bytes per column, excluding id and updated_at', () => {
    const row: FolderRow = {
      id: 'f1', name: 'Ops', parent_id: null, sort_order: 3, icon: '', color: null,
      created_at: 't', updated_at: 'ignored',
    };
    const cell = (tag: number, bytes: Buffer): Buffer => {
      const head = Buffer.alloc(5);
      head[0] = tag;
      head.writeUInt32BE(bytes.length, 1);
      return Buffer.concat([head, bytes]);
    };
    const int8 = Buffer.alloc(8);
    int8.writeBigInt64BE(3n);
    const msg = Buffer.concat([
      Buffer.from('crow1'),
      cell(3, Buffer.from('Ops')),
      cell(0, Buffer.alloc(0)),
      cell(1, int8),
      cell(3, Buffer.alloc(0)),
      cell(0, Buffer.alloc(0)),
      cell(3, Buffer.from('t')),
    ]);
    expect(rawHash(TBL.folders, row)).toBe(trunc16Hex(crypto.createHash('sha256').update(msg).digest()));
    expect(rawHash(TBL.folders, { ...row, id: 'other', updated_at: 'x' })).toBe(rawHash(TBL.folders, row));
  });

  it('distinguishes storage classes and treats missing columns as NULL', () => {
    const base = entryRow();
    expect(rawHash(TBL.entries, { ...base, port: '22' })).not.toBe(rawHash(TBL.entries, base));
    expect(rawHash(TBL.entries, { ...base, port: 22.5 })).not.toBe(rawHash(TBL.entries, { ...base, port: '22.5' }));
    expect(rawHash(TBL.entries, { ...base, port: BigInt(22) })).toBe(rawHash(TBL.entries, base));
    expect(rawHash(TBL.entries, { ...base, icon: '' })).not.toBe(rawHash(TBL.entries, base));
    const history: HistoryRow = { id: 'h1', entry_id: 'e1', username: null, password_encrypted: null, changed_at: 't', changed_by: null };
    const partial = { id: 'h1', entry_id: 'e1', changed_at: 't' } as unknown as HistoryRow;
    expect(rawHash(TBL.history, partial)).toBe(rawHash(TBL.history, history));
  });

  it('changes when a secret is re-encrypted while the keyed vhash stays equal', () => {
    const kEpoch = Buffer.alloc(32, 7);
    const kSync = deriveEpochKeys(kEpoch, LINEAGE).kSync;
    const ct1 = aesGcm(kEpoch, Buffer.alloc(12, 1), 'hunter2');
    const ct2 = aesGcm(kEpoch, Buffer.alloc(12, 2), 'hunter2');
    const r1 = rawHash(TBL.entries, entryRow({ password_encrypted: ct1 }));
    const r2 = rawHash(TBL.entries, entryRow({ password_encrypted: ct2 }));
    expect(r1).not.toBe(r2);
    expect(vhashOfSecret(password, openGcm(kEpoch, ct1), kSync)).toBe(vhashOfSecret(password, openGcm(kEpoch, ct2), kSync));
  });

  it('refuses cells it cannot encode', () => {
    expect(() => rawHash(TBL.entries, entryRow({ port: {} as unknown as number }))).toThrow(/raw_hash/);
  });

  it('hashes 5,000 entry rows well inside the capture budget', () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      entryRow({ id: `e${i}`, name: `Entry ${i}`, notes: 'n'.repeat(200), password_encrypted: crypto.randomBytes(40) }),
    );
    const t0 = performance.now();
    for (const row of rows) rawHash(TBL.entries, row);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});

describe('ids', () => {
  it('builds RFC 4122 version-5 UUIDs', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidV5('6BA7B810-9DAD-11D1-80B4-00C04FD430C8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(() => uuidV5('not-a-uuid', 'x')).toThrow();
  });

  it('derives lineage and vault ids deterministically', () => {
    const lineage = lineageIdFromSalt('c2FsdA==');
    expect(lineage).toBe(uuidV5('da5aafb2-40e7-4b0e-b2d4-cc828d8d30b7', 'conduit-lineage:c2FsdA=='));
    expect(lineage).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(vaultIdFor(lineage)).toBe(uuidV5(lineage, 'vault-id'));
    expect(lineageIdFromSalt('c2FsdB==')).not.toBe(lineage);
  });

  it('hashes genesis bytes and account hints', () => {
    expect(genesisIdOf(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const expected = trunc16Hex(crypto.createHash('sha256').update(`conduit-acct-v1${LINEAGE}user-1`).digest());
    expect(accountHint(LINEAGE, 'user-1')).toBe(expected);
  });

  it('derives 48-bit non-zero devs', () => {
    const inc = '0f'.repeat(16);
    const dev = deriveDev('device-a', LINEAGE, inc);
    const digest = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(`device-a${LINEAGE}`), Buffer.from(inc, 'hex')])).digest();
    expect(dev).toBe(digest.readUIntBE(0, 6) || 1);
    expect(dev).toBeGreaterThan(0);
    expect(dev).toBeLessThan(2 ** 48);
    expect(deriveDev('device-a', LINEAGE, 'f0'.repeat(16))).not.toBe(dev);
    expect(() => deriveDev('device-a', LINEAGE, 'abc')).toThrow(/incarnation/);
    expect(() => deriveDev('device-a', LINEAGE, 'zz'.repeat(16))).toThrow(/incarnation/);
  });

  it('derives synthetic candidate devs from 16 random bytes', () => {
    const rand = Buffer.alloc(16, 9);
    const digest = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('canddevice-a'), rand])).digest();
    expect(deriveSyntheticDev('device-a', rand)).toBe(digest.readUIntBE(0, 6) || 1);
    expect(() => deriveSyntheticDev('device-a', Buffer.alloc(15))).toThrow();
  });
});

describe('makeImplicitProvider', () => {
  const keys = deriveEpochKeys(KEY32, LINEAGE);

  it('builds genesis siblings with the default value and its vhash', () => {
    const implicit = makeImplicitProvider(keys.kSync);
    for (const def of fixedRegisters(TBL.entries).filter((d) => !d.secret)) {
      const key = regKey(TBL.entries, 'e9', def.reg);
      const s = implicit(key);
      expect(s).toMatchObject({ dev: 0, ms: 0, c: 0, pid: ZERO_PID, lt: 0, flags: 0, prevVhash: null });
      expect(s.value).toBe(def.defaultValue);
      expect(s.vhash).toBe(vhashOfValue(key, def.defaultValue));
    }
  });

  it('keys the implicit secret vhash with the epoch kSync', () => {
    const s = makeImplicitProvider(keys.kSync)(password);
    expect(s.vhash).toBe(vhashKeyed(password, Buffer.of(0), keys.kSync));
    expect(makeImplicitProvider(deriveEpochKeys(Buffer.alloc(32, 1), LINEAGE).kSync)(password).vhash).not.toBe(s.vhash);
  });

  it('hashes 50,000 registers well inside the capture budget', () => {
    const implicit = makeImplicitProvider(keys.kSync);
    const regs = fixedRegisters(TBL.entries).filter((d) => !d.secret).map((d) => d.reg);
    const t0 = performance.now();
    for (let i = 0; i < 50_000; i++) implicit(regKey(TBL.entries, `row-${i}`, regs[i % regs.length]));
    expect(performance.now() - t0).toBeLessThan(300);
  });
});
