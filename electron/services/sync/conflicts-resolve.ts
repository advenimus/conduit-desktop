/**
 * Conflict resolutions (spec 7.3): each returns LocalWrite[] for ONE interactive dot, applied
 * by the caller with capture-local.applyLocalWrites. Writes replace every sibling and are
 * force-stamped even when equal to the provisional value. Import through conflicts.ts.
 */

import { CONTAINER_ROOT, DOCUMENT_CONTENT_REG, LIFE_DEAD, LIFE_LIVE, formatContainer, regKey, requireDef } from './catalog.js';
import { prepareWrite } from './capture-local.js';
import { jcsFromText } from './jcs.js';
import { isEntryPassword, keepBothCopies, losingPasswordHistory } from './conflicts-copy.js';
import { rowsInsideFolder } from './conflicts-list.js';
import {
  CONTAINER_REG,
  LIFE_REG,
  NOTES_REG,
  conflictedRegisters,
  conflictedRegistersOfRow,
  findVersion,
  hasUndecryptableSibling,
  highestRankEligible,
  requireWritableVersion,
  type ConflictContext,
} from './conflicts-shared.js';
import { isEligible, isPseudo } from './sibling.js';
import { getRegister, getRow, provisional, rowKeyStr, rowLife, sibsOf } from './state-view.js';
import { TBL } from './types.js';
import type {
  BulkChoice,
  CycleChoice,
  CycleConflict,
  EditDeleteChoice,
  FieldChoice,
  FolderDeleteChoice,
  ImplicitProvider,
  LocalWrite,
  RegKey,
  RowKey,
  Sibling,
  SyncContext,
  SyncState,
  SyncValue,
} from './types.js';

const REPLACE_ALL = 'replace-all';

function lifeKey(row: RowKey): RegKey {
  return regKey(row.tbl, row.rowId, LIFE_REG);
}

function lifeWrite(row: RowKey, value: string, ctx: SyncContext): LocalWrite {
  return prepareWrite(lifeKey(row), { value }, ctx, REPLACE_ALL);
}

function copyWrite(key: RegKey, sib: Sibling, ctx: SyncContext): LocalWrite {
  return prepareWrite(key, { sibling: requireWritableVersion(sib) }, ctx, REPLACE_ALL);
}

function keepBothAllowed(key: RegKey): boolean {
  return key.tbl === TBL.entries && (key.reg === NOTES_REG || key.reg === DOCUMENT_CONTENT_REG);
}

/** A setting holds JSON text; anything else would break the entry's `config` column. */
function requireJsonValue(key: RegKey, value: SyncValue): void {
  if (typeof value === 'string' && jcsFromText(value) === null) {
    throw new Error(`conflict resolution: the value for ${key.reg} is not valid JSON`);
  }
}

function valueWrite(key: RegKey, choice: Extract<FieldChoice, { kind: 'value' }>, ctx: SyncContext): LocalWrite {
  const def = requireDef(key);
  if (def.kind === 'json') requireJsonValue(key, choice.value);
  const input = def.secret ? { plaintext: choice.plaintext ?? null } : { value: choice.value };
  return prepareWrite(key, input, ctx, REPLACE_ALL);
}

/**
 * Field resolution (7.3): one replace-all write with the chosen value, force-stamped even when
 * equal to the provisional value. For `password`, adds history rows for losing plaintexts
 * (changed_by 'conflict-resolution'). 'keep-both' is only valid for notes and document content.
 */
export function resolveField(state: SyncState, key: RegKey, choice: FieldChoice, ctx: SyncContext): LocalWrite[] {
  if (choice.kind === 'keep-both') {
    if (!keepBothAllowed(key)) throw new Error(`conflict resolution: [Keep both] is not offered for ${key.reg}`);
    const reg = getRegister(state, key);
    const keep = reg ? provisional(key.reg, reg.sibs) : null;
    if (!keep) throw new Error(`conflict resolution: ${key.reg} has no version to keep`);
    return [copyWrite(key, keep, ctx), ...keepBothCopies(state, key, keep, choice.copyNames, ctx)];
  }
  const write =
    choice.kind === 'version' ? copyWrite(key, findVersion(state, key, choice.versionId), ctx) : valueWrite(key, choice, ctx);
  if (!isEntryPassword(key)) return [write];
  return [write, ...losingPasswordHistory(state, key, write.vhash, ctx)];
}

/** Group A (icon, color, is_favorite, tags): 'keep-newest' or a version id per register name. */
export function resolveAppearance(
  state: SyncState,
  row: RowKey,
  choices: 'keep-newest' | ReadonlyMap<string, string>,
  ctx: SyncContext,
): LocalWrite[] {
  if (choices !== 'keep-newest') {
    return [...choices].map(([reg, versionId]) => {
      const key = regKey(row.tbl, row.rowId, reg);
      return copyWrite(key, findVersion(state, key, versionId), ctx);
    });
  }
  const r = getRow(state, row);
  const out: LocalWrite[] = [];
  for (const c of r ? conflictedRegistersOfRow(r) : []) {
    if (c.def.cls !== 'groupA') continue;
    const newest = highestRankEligible(c.reg.sibs);
    if (newest) out.push(copyWrite(c.reg.key, newest, ctx));
  }
  return out;
}

/** [Keep item] / [Delete item]: `_life` live or dead, replacing all. */
export function resolveEditDelete(state: SyncState, row: RowKey, choice: EditDeleteChoice, ctx: SyncContext): LocalWrite[] {
  if (!getRow(state, row)) throw new Error(`conflict resolution: unknown row ${rowKeyStr(row)}`);
  return [lifeWrite(row, choice === 'keep' ? LIFE_LIVE : LIFE_DEAD, ctx)];
}

/** Same delete: same app dot, or pseudo siblings of one legacy absorption (same ms and lt). */
function sameDeleteDot(a: Sibling, b: Sibling): boolean {
  if (isPseudo(a) !== isPseudo(b)) return false;
  if (isPseudo(a)) return a.ms === b.ms && a.lt === b.lt;
  return a.dev === b.dev && a.ms === b.ms && a.c === b.c;
}

/** Dead rows whose `_life` winner is one of the folder's delete dots. */
function rowsDeletedWith(state: SyncState, deletes: readonly Sibling[], implicit: ImplicitProvider): RowKey[] {
  const out: RowKey[] = [];
  for (const row of state.rows.values()) {
    const tbl = row.key.tbl;
    if ((tbl !== TBL.entries && tbl !== TBL.folders) || rowLife(state, row.key) !== 'dead') continue;
    const winner = provisional(LIFE_REG, sibsOf(state, lifeKey(row.key), implicit));
    if (winner && deletes.some((d) => sameDeleteDot(d, winner))) out.push(row.key);
  }
  return out;
}

/** Folder delete versus edits inside (7.3); 'restore-all' writes live on every row whose `_life` winner is that delete dot. */
export function resolveFolderDelete(
  state: SyncState,
  folder: RowKey,
  choice: FolderDeleteChoice,
  ctx: SyncContext,
  implicit: ImplicitProvider,
): LocalWrite[] {
  if (!getRow(state, folder)) throw new Error(`conflict resolution: unknown folder ${folder.rowId}`);
  if (choice === 'keep-with-changed') return [lifeWrite(folder, LIFE_LIVE, ctx)];
  if (choice === 'delete-all') {
    const inside = rowsInsideFolder(state, folder).filter((r) => rowKeyStr(r) !== rowKeyStr(folder));
    return [lifeWrite(folder, LIFE_DEAD, ctx), ...inside.map((r) => lifeWrite(r, LIFE_DEAD, ctx))];
  }
  const deletes = sibsOf(state, lifeKey(folder), implicit).filter((s) => isEligible(s) && s.value === LIFE_DEAD);
  const revived = rowsDeletedWith(state, deletes, implicit).filter((r) => rowKeyStr(r) !== rowKeyStr(folder));
  return [lifeWrite(folder, LIFE_LIVE, ctx), ...revived.map((r) => lifeWrite(r, LIFE_LIVE, ctx))];
}

/**
 * Cycle choices: container writes. [Put X in Y] moves X under Y and Y to the top level, which
 * breaks the cycle whatever its length (every other node still points into the cycle).
 */
export function resolveCycle(cycle: CycleConflict, choice: CycleChoice, ctx: SyncContext): LocalWrite[] {
  const kind = cycle.tbl === TBL.folders ? 'f' : 'e';
  const containerWrite = (rowId: string, value: string): LocalWrite =>
    prepareWrite(regKey(cycle.tbl, rowId, CONTAINER_REG), { value }, ctx, REPLACE_ALL);
  if (choice.kind === 'all-root') return cycle.rowIds.map((id) => containerWrite(id, CONTAINER_ROOT));
  const { child, parent } = choice;
  if (child === parent || !cycle.rowIds.includes(child) || !cycle.rowIds.includes(parent)) {
    throw new Error('conflict resolution: [Put X in Y] needs two different rows of the cycle');
  }
  return [containerWrite(child, formatContainer({ kind, id: parent })), containerWrite(parent, CONTAINER_ROOT)];
}

function holdsOlderAppChange(sibs: readonly Sibling[]): boolean {
  return sibs.some((s) => isPseudo(s) && s.ms > 0);
}

/** [Keep newest for all] / [Keep newest for all older-app changes], by rank (includes lt). */
export function resolveBulk(state: SyncState, choice: BulkChoice, _cctx: ConflictContext, ctx: SyncContext): LocalWrite[] {
  const out: LocalWrite[] = [];
  for (const c of conflictedRegisters(state)) {
    if (c.def.cls === 'special' || hasUndecryptableSibling(c.reg.sibs)) continue;
    if (choice === 'keep-newest-older-apps' && !holdsOlderAppChange(c.reg.sibs)) continue;
    const newest = highestRankEligible(c.reg.sibs);
    if (newest) out.push(copyWrite(c.reg.key, newest, ctx));
  }
  return out;
}

/** [Discard] an undecryptable value: replace-all write of the current provisional value. */
export function discardUndecryptable(state: SyncState, key: RegKey, ctx: SyncContext): LocalWrite[] {
  const reg = getRegister(state, key);
  if (!reg) throw new Error(`conflict resolution: ${key.reg} has no explicit versions`);
  const prov = provisional(key.reg, reg.sibs);
  if (prov) return [copyWrite(key, prov, ctx)];
  const def = requireDef(key);
  const input = def.secret ? { plaintext: null } : { value: def.defaultValue };
  return [prepareWrite(key, input, ctx, REPLACE_ALL)];
}
