// Read-only checks on a vault file (spec 3.3, 4.7, 5.9): its sync identity (lineage, genesis,
// vault id), one entry's grave, registers and siblings (redaction after "Delete permanently"), its
// secret column as stored, and a raw byte search. SQLite reads go through a private copy, so no
// side files ever appear next to the file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { withPrivateCopy } from './sync-files.mjs';

const TBL_ENTRIES = 1;
const TBL_HISTORY = 3;
const SIB_REDACTED = 2;
const LIFE_REG = '_life';
const ZERO_VHASH = /^0+$/;

export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hasTable(db, name) {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== undefined;
}

/** {lineageId, genesisId, fileId, vaultId} of a vault file (sync fields null for a pre-sync file). */
export function vaultIdentity(file, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => {
    const synced = hasTable(db, 'sync_state');
    const state = (k) => (synced ? db.prepare('select value from sync_state where key = ?').get(k)?.value ?? null : null);
    const vaultId = db.prepare("select value from vault_meta where key = 'vault_id'").get()?.value ?? null;
    return { lineageId: state('lineage_id'), genesisId: state('genesis_id'), fileId: state('file_id'), vaultId };
  });
}

function registersOf(db, rid) {
  return db.prepare('select reg, flags, hex(vhash) as vhash, mat from sync_reg where rid = ?').all(rid);
}

function siblingsOf(db, rid) {
  return db.prepare('select reg, flags, value is null as valueNull from sync_sibling where rid = ?').all(rid);
}

/** Registers other than `_life` whose values are all gone: vhash zero, flag bit 1, no sibling value. */
function redactedRegs(regs, sibs) {
  const content = regs.filter((r) => r.reg !== LIFE_REG);
  const regsDone = content.every((r) => ZERO_VHASH.test(r.vhash) && (r.flags & SIB_REDACTED) !== 0 && r.mat === null);
  const sibsDone = sibs.filter((s) => s.reg !== LIFE_REG).every((s) => s.valueNull === 1 && (s.flags & SIB_REDACTED) !== 0);
  return { contentRegs: content.length, allRedacted: regsDone && sibsDone };
}

function historyRowsFor(db, entryId) {
  if (!hasTable(db, 'password_history')) return { contentRows: 0, rids: [] };
  const contentRows = db.prepare('select count(*) as n from password_history where entry_id = ?').get(entryId).n;
  const rids = db.prepare('select k.rid from sync_rowkey k where k.tbl = ? and k.row_id in (select id from password_history where entry_id = ?)').all(TBL_HISTORY, entryId).map((r) => r.rid);
  return { contentRows, rids };
}

/**
 * How entry `entryId` is stored in a synced vault file: {known, contentRow, grave: {rowJson,
 * redacted} | null, regs: {contentRegs, allRedacted}, history: {contentRows, rids}}.
 */
export function entryStorage(file, entryId, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => {
    const key = db.prepare('select rid from sync_rowkey where tbl = ? and row_id = ?').get(TBL_ENTRIES, entryId);
    const contentRow = db.prepare('select count(*) as n from entries where id = ?').get(entryId).n === 1;
    if (!key) return { known: false, contentRow, grave: null, regs: null, history: historyRowsFor(db, entryId) };
    const g = db.prepare('select row_json as rowJson, redacted from sync_grave where rid = ?').get(key.rid) ?? null;
    return {
      known: true,
      contentRow,
      grave: g === null ? null : { rowJson: g.rowJson, redacted: g.redacted },
      regs: redactedRegs(registersOf(db, key.rid), siblingsOf(db, key.rid)),
      history: historyRowsFor(db, entryId),
    };
  });
}

/** entries.password_encrypted of a live entry as stored in the file (a Buffer), or null. */
export function storedPasswordCipher(file, entryId, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => db.prepare('select password_encrypted as p from entries where id = ?').get(entryId)?.p ?? null);
}

/** password_history.password_encrypted of every history row of `entryId` (Buffers). */
export function historyPasswordCiphers(file, entryId, scratchDir) {
  return withPrivateCopy(file, scratchDir, (db) => {
    if (!hasTable(db, 'password_history')) return [];
    return db.prepare('select password_encrypted as p from password_history where entry_id = ? and password_encrypted is not null').all(entryId).map((r) => r.p);
  });
}

/**
 * Labels of the `needles` ({label: string | Buffer}) found anywhere in the file's bytes. A Buffer
 * is also searched as base64 and hex, the encodings a JSON grave ({"$b64": ...}) or a text column
 * would hold it in.
 */
export function bytesContaining(file, needles) {
  const bytes = fs.readFileSync(file);
  const forms = (v) => (Buffer.isBuffer(v)
    ? [v, Buffer.from(v.toString('base64')), Buffer.from(v.toString('hex')), Buffer.from(v.toString('hex').toUpperCase())]
    : [Buffer.from(String(v), 'utf8')]);
  return Object.entries(needles).filter(([, v]) => forms(v).some((f) => f.length > 0 && bytes.includes(f))).map(([label]) => label);
}
