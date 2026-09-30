/**
 * What [Roll this vault back] changes (spec 5.10): every catalog register of every backup row
 * compared with the current provisional value (secrets by keyed vhash after decrypting the
 * backup's ciphertext), rows the backup lacks, and rows the backup holds that are dead or
 * unknown now. Pure; plaintext lives only inside the returned plan. Import through restore.ts.
 */

import { canonEqual } from './canonical.js';
import { compareRowKeys, isItemTbl, previewRow, rowTitle } from './candidates-shared.js';
import { LIFE_REG, asBlob, asText, isDefaultValue, readContentRow, registerDef, regKey, rowKey } from './catalog.js';
import { vhashOfSecret } from './hashing.js';
import { openSecret, readSecret } from './key-epoch.js';
import { provisional, rowKeyStr, rowLife } from './state-view.js';
import type { RollbackInput } from './restore-types.js';
import {
  TBL,
  type ContentRow,
  type ContentSnapshot,
  type ContentTbl,
  type EpochKeys,
  type ImplicitProvider,
  type PreviewRow,
  type RegKey,
  type RegisterDef,
  type RowKey,
  type Sibling,
  type SyncContext,
  type SyncState,
  type SyncValue,
} from './types.js';

const ROLLBACK_TBLS: readonly ContentTbl[] = [TBL.folders, TBL.entries, TBL.history];
const PASSWORD_REG = 'password';
const NAME_REG = 'name';
const ENTRY_ID_REG = 'entry_id';

export interface FieldPlan {
  readonly key: RegKey;
  readonly secret: boolean;
  /** Current provisional value (non-secrets; null for secrets). */
  readonly current: SyncValue;
  /** The backup's value (non-secrets; null for secrets). */
  readonly incoming: SyncValue;
  /** Secrets: the backup's plaintext (null = no secret). Never logged or previewed. */
  readonly plaintext: string | null;
  /** Entry passwords only: the non-empty current plaintext that goes to password_history first. */
  readonly replacedPlaintext: string | null;
}

export interface RowPlan {
  readonly row: RowKey;
  readonly title: string;
  /** 'update': live now; 'restore': dead or unknown now (re-created with `_life = live`). */
  readonly kind: 'update' | 'restore';
  readonly fields: readonly FieldPlan[];
}

export interface RollbackPlan {
  readonly deletions: readonly PreviewRow[];
  /** Restore rows, and update rows with at least one field. */
  readonly rows: readonly RowPlan[];
  readonly unreadableSecrets: number;
}

interface PlanEnv {
  readonly current: SyncState;
  readonly implicit: ImplicitProvider;
  readonly ctx: SyncContext;
  readonly backupKeys: EpochKeys | null;
  readonly backup: ContentSnapshot;
  unreadable: number;
}

type Values = ReadonlyMap<string, SyncValue>;

export function planRollback(input: RollbackInput): RollbackPlan {
  const env: PlanEnv = {
    current: input.current,
    implicit: input.implicit,
    ctx: input.ctx,
    backupKeys: input.backup.keys,
    backup: input.backup.content,
    unreadable: 0,
  };
  const inBackup = new Set<string>();
  const rows: RowPlan[] = [];
  for (const tbl of ROLLBACK_TBLS) {
    for (const row of tableRows(env.backup, tbl)) {
      const rk = rowKey(tbl, row.id);
      inBackup.add(rowKeyStr(rk));
      const plan = planRow(env, rk, readValues(tbl, row));
      if (plan !== null) rows.push(plan);
    }
  }
  return {
    deletions: deletionsOf(env.current, inBackup),
    rows: rows.sort((a, b) => compareRowKeys(a.row, b.row)),
    unreadableSecrets: env.unreadable,
  };
}

function tableRows(content: ContentSnapshot, tbl: ContentTbl): Iterable<ContentRow> {
  if (tbl === TBL.entries) return content.entries.values();
  if (tbl === TBL.folders) return content.folders.values();
  return content.history.values();
}

function readValues(tbl: ContentTbl, row: ContentRow): Values {
  return readContentRow(tbl, row).values;
}

/**
 * Items (entries, folders) live now that the backup lacks. Password history the backup lacks
 * is kept: it may hold passwords used since the backup, and it hides with a deleted entry.
 */
function deletionsOf(current: SyncState, inBackup: ReadonlySet<string>): PreviewRow[] {
  const out: RowKey[] = [];
  for (const [k, row] of current.rows) {
    if (isItemTbl(row.key.tbl) && !inBackup.has(k) && rowLife(current, row.key) === 'live') out.push(row.key);
  }
  return out.sort(compareRowKeys).map((r) => previewRow(r, rowTitle(current, r)));
}

function planRow(env: PlanEnv, rk: RowKey, values: Values): RowPlan | null {
  const life = rowLife(env.current, rk);
  const fields: FieldPlan[] = [];
  for (const reg of registerNames(env.current, rk, values)) {
    const key = regKey(rk.tbl, rk.rowId, reg);
    const def = registerDef(key);
    if (def === null) continue;
    const incoming = values.has(reg) ? (values.get(reg) as SyncValue) : def.defaultValue;
    const field = life === 'unknown' ? newField(env, key, def, incoming) : diffField(env, key, def, incoming);
    if (field !== null) fields.push(field);
  }
  if (life === 'live' && fields.length === 0) return null;
  return { row: rk, title: titleOf(env, rk, values), kind: life === 'live' ? 'update' : 'restore', fields };
}

/** The backup's registers plus the current row's explicit ones (a dynamic register the backup lacks is null there). */
function registerNames(current: SyncState, rk: RowKey, values: Values): Set<string> {
  const names = new Set(values.keys());
  for (const name of current.rows.get(rowKeyStr(rk))?.regs.keys() ?? []) names.add(name);
  names.delete(LIFE_REG);
  return names;
}

/** A row the vault never saw: every non-default register. */
function newField(env: PlanEnv, key: RegKey, def: RegisterDef, incoming: SyncValue): FieldPlan | null {
  if (!def.secret) return isDefaultValue(def, incoming) ? null : field(key, false, null, incoming);
  const plaintext = openBackupSecret(env, incoming);
  if (plaintext === undefined || plaintext === null || plaintext.length === 0) return null;
  return { key, secret: true, current: null, incoming: null, plaintext, replacedPlaintext: null };
}

function diffField(env: PlanEnv, key: RegKey, def: RegisterDef, incoming: SyncValue): FieldPlan | null {
  const cur = currentView(env, key);
  if (!def.secret) {
    if (cur !== null && canonEqual(def, cur.value, incoming)) return null;
    return field(key, false, cur?.value ?? null, incoming);
  }
  const plaintext = openBackupSecret(env, incoming);
  if (plaintext === undefined) return null;
  if (cur !== null && cur.vhash === vhashOfSecret(key, plaintext, env.ctx.keys.current.kSync)) return null;
  const replaced = replacedPassword(env, key, cur);
  if (replaced === undefined) return null;
  return { key, secret: true, current: null, incoming: null, plaintext, replacedPlaintext: replaced };
}

function field(key: RegKey, secret: boolean, current: SyncValue, incoming: SyncValue): FieldPlan {
  return { key, secret, current, incoming, plaintext: null, replacedPlaintext: null };
}

/** Provisional sibling as materialize sees it (implicit sibling when implicit); null when none is eligible. */
function currentView(env: PlanEnv, key: RegKey): Sibling | null {
  const reg = env.current.rows.get(rowKeyStr(key))?.regs.get(key.reg);
  return reg ? provisional(key.reg, reg.sibs) : env.implicit(key);
}

/**
 * The backup's plaintext: its own key first, then the vault's ring (a backup from an older
 * epoch of this vault). null = no secret; undefined = unreadable (counted, field skipped).
 */
function openBackupSecret(env: PlanEnv, value: SyncValue): string | null | undefined {
  const ct = asBlob(value);
  if (ct === null) return null;
  if (env.backupKeys !== null) {
    const opened = openSecret(ct, env.backupKeys.kEpoch);
    if (opened !== null) return opened.toString('utf8');
  }
  const read = readSecret(ct, env.ctx.keys);
  if (read.kind !== 'undecryptable') return read.plaintext;
  env.unreadable++;
  return undefined;
}

/**
 * Entry passwords: the current non-empty plaintext saved to history before it is replaced.
 * null = nothing to save; undefined = the current value cannot be read, so it is not replaced.
 */
function replacedPassword(env: PlanEnv, key: RegKey, cur: Sibling | null): string | null | undefined {
  if (key.tbl !== TBL.entries || key.reg !== PASSWORD_REG || cur === null) return null;
  const ct = asBlob(cur.value);
  if (ct === null) return null;
  const read = readSecret(ct, env.ctx.keys);
  if (read.kind === 'undecryptable') {
    env.unreadable++;
    return undefined;
  }
  return read.plaintext.length > 0 ? read.plaintext : null;
}

/** Items: current name, else the backup's. History rows: their entry's name. */
function titleOf(env: PlanEnv, rk: RowKey, values: Values): string {
  if (rk.tbl !== TBL.history) return rowTitle(env.current, rk) || (asText(values.get(NAME_REG) ?? null) ?? '');
  const entryId = asText(values.get(ENTRY_ID_REG) ?? null);
  if (entryId === null) return '';
  return rowTitle(env.current, rowKey(TBL.entries, entryId)) || (asText(env.backup.entries.get(entryId)?.name ?? null) ?? '');
}
