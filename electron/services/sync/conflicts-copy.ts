/**
 * Writes that copy losing versions somewhere safe (spec 7.3): password_history rows for losing
 * password plaintexts, and [Keep both] copies of an entry for notes and document content.
 * Import through conflicts.ts.
 */

import { formatIsoMs } from './canonical.js';
import { LIFE_LIVE, registerDef, regKey } from './catalog.js';
import { prepareWrite } from './capture-local.js';
import {
  CHANGED_BY_CONFLICT,
  COPY_NAME_SUFFIX,
  LIFE_REG,
  NAME_REG,
  sortByRankDesc,
  uuidV4,
} from './conflicts-shared.js';
import { readSecret } from './key-epoch.js';
import { identityKey, isEligible } from './sibling.js';
import { getRegister, getRow, provisional, provisionalValue, rowOf } from './state-view.js';
import { TBL } from './types.js';
import type { LocalWrite, RegKey, Sibling, SyncContext, SyncState } from './types.js';

const UUID_RANDOM_BYTES = 16;
const HISTORY_REGS = { entryId: 'entry_id', username: 'username', password: 'password', changedAt: 'changed_at', changedBy: 'changed_by' };
const USERNAME_REG = 'username';
const PASSWORD_REG = 'password';

const REPLACE_ALL = 'replace-all';

export function isEntryPassword(key: RegKey): boolean {
  return key.tbl === TBL.entries && key.reg === PASSWORD_REG;
}

/** Plaintext of a secret sibling through the ring, or null when no key opens it. */
function plaintextOf(s: Sibling, ctx: SyncContext): string | null {
  if (!(s.value instanceof Uint8Array)) return null;
  const read = readSecret(s.value, ctx.keys);
  return read.kind === 'undecryptable' ? null : read.plaintext;
}

function historyRowWrites(state: SyncState, entryId: string, plaintext: string, ctx: SyncContext): LocalWrite[] {
  const id = uuidV4(ctx.randomBytes(UUID_RANDOM_BYTES));
  const k = (reg: string): RegKey => regKey(TBL.history, id, reg);
  const username = provisionalValue(state, regKey(TBL.entries, entryId, USERNAME_REG), null) ?? null;
  return [
    prepareWrite(k(LIFE_REG), { value: LIFE_LIVE }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.entryId), { value: entryId }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.username), { value: username }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.password), { plaintext }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.changedAt), { value: formatIsoMs(ctx.now()) }, ctx, REPLACE_ALL),
    prepareWrite(k(HISTORY_REGS.changedBy), { value: CHANGED_BY_CONFLICT }, ctx, REPLACE_ALL),
  ];
}

/**
 * One new password_history row per losing distinct plaintext of an entry's password
 * (7.3 secret resolution), so a password still in use somewhere is never lost.
 */
export function losingPasswordHistory(state: SyncState, key: RegKey, chosenVhash: string, ctx: SyncContext): LocalWrite[] {
  const reg = getRegister(state, key);
  if (!reg) return [];
  const seen = new Set([chosenVhash]);
  const out: LocalWrite[] = [];
  for (const s of sortByRankDesc(reg.sibs)) {
    if (!isEligible(s) || seen.has(s.vhash)) continue;
    seen.add(s.vhash);
    const plaintext = plaintextOf(s, ctx);
    if (plaintext) out.push(...historyRowWrites(state, key.rowId, plaintext, ctx));
  }
  return out;
}

/** The provisional values of an entry copied to a new row id, secrets re-encrypted for the new key. */
function copiedRegisterWrites(state: SyncState, source: RegKey, newId: string, ctx: SyncContext): LocalWrite[] {
  const row = getRow(state, rowOf(source));
  if (!row) return [];
  const out: LocalWrite[] = [];
  for (const [name, reg] of row.regs) {
    if (name === LIFE_REG || name === NAME_REG || name === source.reg) continue;
    const p = provisional(name, reg.sibs);
    const def = registerDef(reg.key);
    if (!p || !def) continue;
    const key = regKey(TBL.entries, newId, name);
    if (!def.secret) {
      out.push(prepareWrite(key, { value: p.value }, ctx, REPLACE_ALL));
      continue;
    }
    const plaintext = plaintextOf(p, ctx);
    if (plaintext !== null) out.push(prepareWrite(key, { plaintext }, ctx, REPLACE_ALL));
  }
  return out;
}

/**
 * [Keep both] (7.3): one new entry per other distinct version, holding every provisional value
 * of the row with the chosen register set to that version's value.
 */
export function keepBothCopies(
  state: SyncState,
  key: RegKey,
  keep: Sibling,
  copyNames: ReadonlyMap<string, string>,
  ctx: SyncContext,
): LocalWrite[] {
  const reg = getRegister(state, key);
  if (!reg) return [];
  const baseName = provisionalValue(state, regKey(key.tbl, key.rowId, NAME_REG), '');
  const done = new Set([keep.vhash]);
  const out: LocalWrite[] = [];
  for (const s of sortByRankDesc(reg.sibs)) {
    if (!isEligible(s) || done.has(s.vhash)) continue;
    done.add(s.vhash);
    const id = uuidV4(ctx.randomBytes(UUID_RANDOM_BYTES));
    const name = copyNames.get(identityKey(s)) ?? `${typeof baseName === 'string' ? baseName : ''}${COPY_NAME_SUFFIX}`;
    out.push(
      prepareWrite(regKey(TBL.entries, id, LIFE_REG), { value: LIFE_LIVE }, ctx, REPLACE_ALL),
      prepareWrite(regKey(TBL.entries, id, NAME_REG), { value: name }, ctx, REPLACE_ALL),
      prepareWrite(regKey(TBL.entries, id, key.reg), { value: s.value }, ctx, REPLACE_ALL),
      ...copiedRegisterWrites(state, key, id, ctx),
    );
  }
  return out;
}
