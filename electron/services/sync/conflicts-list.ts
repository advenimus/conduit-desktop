/**
 * listConflicts (spec 4.10, 7.2): derived from the state on every call, grouped by row, plus
 * structural conflicts from the last materialization; version sources, masking, stale-revert
 * and invariant-guard markers, snooze keys (7.4) and device names from presence registers.
 * Import through conflicts.ts.
 */

import { DOCUMENT_CONTENT_REG, LIFE_DEAD, LIFE_LIVE, SYNC_ROW, isContentTbl, registerDef, registerLabel, regKey } from './catalog.js';
import {
  LIFE_REG,
  MASTER_PASSWORD_TITLE,
  NAME_REG,
  NOTES_REG,
  conflictedRegisters,
  hasUndecryptableSibling,
  highestRankEligible,
  sortByRankDesc,
  type ConflictContext,
  type ConflictedRegister,
} from './conflicts-shared.js';
import { secretRevertPrevs } from './capture-legacy-rules.js';
import { prevOf, sha256 } from './hashing.js';
import { readSecret } from './key-epoch.js';
import { isConflict } from './merge.js';
import { compareStr, identityKey, isEligible, isPseudo, isRedacted, isUndecryptable, isValueUnknown } from './sibling.js';
import { containerChain, provisional, provisionalValue, regKeyStr, rowKeyStr, rowLife, sibsOf } from './state-view.js';
import { TBL } from './types.js';
import type {
  ConflictGroup,
  ConflictItem,
  ConflictVersion,
  FieldConflict,
  ImplicitProvider,
  KeyRing,
  RegKey,
  RegisterDef,
  RowKey,
  Sibling,
  SyncState,
  VersionSource,
} from './types.js';

const UNIT_SEP = Buffer.from([0x1f]);
const SNOOZE_KEY_BYTES = 16;

function trunc16Hex(...parts: Uint8Array[]): string {
  return sha256(...parts).subarray(0, SNOOZE_KEY_BYTES).toString('hex');
}

/** Snooze key (7.4): hex(trunc16(SHA-256(regKeyStr || 0x1f || sorted identity keys joined by 0x1f))). */
export function snoozeKeyOf(key: RegKey, sibs: readonly Sibling[]): string {
  const ids = sibs.map(identityKey).sort(compareStr).join('\u001f');
  return trunc16Hex(Buffer.from(regKeyStr(key), 'utf8'), UNIT_SEP, Buffer.from(ids, 'utf8'));
}

/** Appearance items combine their fields: hex(trunc16(SHA-256(sorted field snooze keys joined by 0x1f))). */
function combinedSnoozeKey(keys: readonly string[]): string {
  return trunc16Hex(Buffer.from([...keys].sort(compareStr).join('\u001f'), 'utf8'));
}

/** device_uuid -> display name from `_sync/device/*` presence registers. */
export function deviceNamesFromPresence(state: SyncState): Map<string, string> {
  const out = new Map<string, string>();
  const row = state.rows.get(rowKeyStr({ tbl: TBL.sync, rowId: SYNC_ROW.device }));
  if (!row) return out;
  for (const [uuid, reg] of row.regs) {
    const name = presenceName(provisional(uuid, reg.sibs)?.value ?? null);
    if (name !== null) out.set(uuid, name);
  }
  return out;
}

function presenceName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const name = typeof parsed === 'object' && parsed !== null ? (parsed as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? name : null;
  } catch {
    // Presence values come from other devices; a malformed one only loses its display name.
    return null;
  }
}

interface ListEnv {
  readonly state: SyncState;
  readonly cctx: ConflictContext;
  readonly names: ReadonlyMap<string, string>;
}

function sourceOf(s: Sibling, env: ListEnv): VersionSource {
  if (isPseudo(s)) return s.ms === 0 ? { kind: 'genesis' } : { kind: 'older-app' };
  const label = env.cctx.candidateLabels.get(s.dev);
  if (label !== undefined) return { kind: 'candidate', label };
  const uuid = env.state.devs.get(s.dev)?.deviceUuid ?? null;
  return { kind: 'device', deviceUuid: uuid, deviceName: uuid === null ? null : env.names.get(uuid) ?? null };
}

function versionOf(s: Sibling, def: RegisterDef, prov: Sibling | null, env: ListEnv): ConflictVersion {
  const redacted = isRedacted(s);
  const masked = def.secret;
  return {
    id: identityKey(s),
    dev: s.dev,
    ms: s.ms,
    c: s.c,
    lt: s.lt,
    pseudo: isPseudo(s),
    source: sourceOf(s, env),
    timeMs: isPseudo(s) ? s.lt : s.ms,
    value: masked || redacted ? null : s.value,
    masked,
    vhash: s.vhash,
    provisional: s === prov,
    undecryptable: isUndecryptable(s),
    redacted,
  };
}

/** Siblings whose value this replica lacks are placeholders, not versions the user can pick. */
function versionsOf(reg: string, sibs: readonly Sibling[], def: RegisterDef, env: ListEnv): ConflictVersion[] {
  const prov = provisional(reg, sibs);
  return sortByRankDesc(sibs.filter((s) => !isValueUnknown(s))).map((s) => versionOf(s, def, prov, env));
}

/** A secret sibling's plaintext under any ring key (null for a cleared secret); undefined when unreadable. */
function secretPlaintext(value: unknown, ring: KeyRing): string | null | undefined {
  if (value === null || (value instanceof Uint8Array && value.length === 0)) return null;
  if (!(value instanceof Uint8Array)) return undefined;
  const read = readSecret(value, ring);
  return read.kind === 'undecryptable' ? undefined : read.plaintext;
}

/**
 * prev forms a pseudo sibling's value may appear under in an app sibling's prev_vhash. A secret's
 * prev_vhash keeps the K_sync in force when it was written, while a password change re-keys
 * vhashes, so a readable secret is hashed under every ring epoch (as legacy capture does).
 */
function revertPrevs(key: RegKey, def: RegisterDef, p: Sibling, ring: KeyRing | undefined): readonly string[] {
  const own = prevOf(p.vhash);
  if (!def.secret || ring === undefined || !isEligible(p)) return [own];
  const plain = secretPlaintext(p.value, ring);
  return plain === undefined ? [own] : [own, ...secretRevertPrevs(key, plain, ring)];
}

/** An older app wrote back a value a newer app sibling had replaced (4.3 rule 3). */
function isStaleRevert(c: ConflictedRegister, ring: KeyRing | undefined): boolean {
  const sibs = c.reg.sibs;
  const prevs = new Set(sibs.filter((s) => !isPseudo(s) && s.prevVhash !== null).map((s) => s.prevVhash));
  if (prevs.size === 0) return false;
  return sibs.some((p) => isPseudo(p) && !isRedacted(p) && revertPrevs(c.reg.key, c.def, p, ring).some((x) => prevs.has(x)));
}

function fieldOf(c: ConflictedRegister, env: ListEnv): FieldConflict {
  const key = c.reg.key;
  return {
    key,
    label: registerLabel(key),
    cls: c.def.cls,
    secret: c.def.secret,
    versions: versionsOf(key.reg, c.reg.sibs, c.def, env),
    staleRevert: isStaleRevert(c, env.cctx.keys),
    keepBothOffered: key.tbl === TBL.entries && (key.reg === NOTES_REG || key.reg === DOCUMENT_CONTENT_REG),
    invariantGuard: env.cctx.repairedKeys.has(regKeyStr(key)),
    snoozeKey: snoozeKeyOf(key, c.reg.sibs),
  };
}

function lifeVersions(c: ConflictedRegister, value: string, env: ListEnv): ConflictVersion[] {
  const sibs = c.reg.sibs.filter((s) => isEligible(s) && s.value === value);
  const prov = provisional(LIFE_REG, c.reg.sibs);
  return sortByRankDesc(sibs).map((s) => versionOf(s, c.def, prov, env));
}

/** Live entries and folders whose container chain passes through `folder`. */
export function rowsInsideFolder(state: SyncState, folder: RowKey): RowKey[] {
  const target = rowKeyStr(folder);
  const out: RowKey[] = [];
  for (const row of state.rows.values()) {
    const tbl = row.key.tbl;
    if ((tbl !== TBL.entries && tbl !== TBL.folders) || rowLife(state, row.key) !== 'live') continue;
    if (containerChain(state, row.key).some((k) => rowKeyStr(k) === target)) out.push(row.key);
  }
  return out.sort((a, b) => a.tbl - b.tbl || compareStr(a.rowId, b.rowId));
}

function lifeItem(c: ConflictedRegister, env: ListEnv): ConflictItem | null {
  const row = c.row.key;
  const snoozeKey = snoozeKeyOf(c.reg.key, c.reg.sibs);
  const deleted = lifeVersions(c, LIFE_DEAD, env);
  if (row.tbl === TBL.entries) {
    return { kind: 'edit-delete', row, deleted, edited: lifeVersions(c, LIFE_LIVE, env), snoozeKey };
  }
  if (row.tbl === TBL.folders) {
    return { kind: 'folder-delete', folder: row, deleted, changedItems: rowsInsideFolder(env.state, row), snoozeKey };
  }
  return null;
}

function appearanceItem(row: RowKey, fields: readonly FieldConflict[], regs: readonly ConflictedRegister[]): ConflictItem {
  const newest = new Map<string, string>();
  for (const c of regs) {
    const top = highestRankEligible(c.reg.sibs);
    if (top) newest.set(c.reg.key.reg, identityKey(top));
  }
  return { kind: 'appearance', row, fields, newest, snoozeKey: combinedSnoozeKey(fields.map((f) => f.snoozeKey)) };
}

/** Items of one row, in catalog register order; group A registers fold into one appearance item. */
function rowItems(regs: readonly ConflictedRegister[], env: ListEnv): ConflictItem[] {
  const items: ConflictItem[] = [];
  const appearance: ConflictedRegister[] = [];
  for (const c of regs) {
    if (hasUndecryptableSibling(c.reg.sibs)) items.push({ kind: 'undecryptable', field: fieldOf(c, env) });
    else if (c.def.cls === 'special') items.push({ kind: 'epoch', versions: versionsOf(c.reg.key.reg, c.reg.sibs, c.def, env) });
    else if (c.reg.key.reg === LIFE_REG) pushIfSet(items, lifeItem(c, env));
    else if (c.def.cls === 'groupA') appearance.push(c);
    else items.push({ kind: 'field', field: fieldOf(c, env) });
  }
  if (appearance.length > 0) {
    items.push(appearanceItem(appearance[0].row.key, appearance.map((c) => fieldOf(c, env)), appearance));
  }
  return items;
}

function pushIfSet(items: ConflictItem[], item: ConflictItem | null): void {
  if (item) items.push(item);
}

function itemSnoozeKey(item: ConflictItem): string | null {
  switch (item.kind) {
    case 'field':
    case 'undecryptable':
      return item.field.snoozeKey;
    case 'appearance':
    case 'edit-delete':
    case 'folder-delete':
      return item.snoozeKey;
    default:
      return null;
  }
}

function groupTitle(state: SyncState, row: RowKey): string {
  if (row.tbl === TBL.sync) return MASTER_PASSWORD_TITLE;
  if (!isContentTbl(row.tbl) || row.tbl === TBL.history) return '';
  const name = provisionalValue(state, regKey(row.tbl, row.rowId, NAME_REG), '');
  return typeof name === 'string' ? name : '';
}

function makeGroup(state: SyncState, row: RowKey, items: readonly ConflictItem[], snoozed: ReadonlySet<string>): ConflictGroup {
  const allSnoozed = items.every((item) => {
    const key = itemSnoozeKey(item);
    return key !== null && snoozed.has(key);
  });
  return { row, title: groupTitle(state, row), items, snoozed: items.length > 0 && allSnoozed };
}

function compareGroups(a: ConflictGroup, b: ConflictGroup): number {
  return a.row.tbl - b.row.tbl || compareStr(a.title, b.title) || compareStr(a.row.rowId, b.row.rowId);
}

/** Every conflicted register and structural conflict, grouped by row, in a stable order. */
export function listConflicts(state: SyncState, cctx: ConflictContext): ConflictGroup[] {
  const env: ListEnv = { state, cctx, names: deviceNamesFromPresence(state) };
  const byRow = new Map<string, { row: RowKey; regs: ConflictedRegister[] }>();
  for (const c of conflictedRegisters(state)) {
    const k = rowKeyStr(c.row.key);
    const entry = byRow.get(k) ?? { row: c.row.key, regs: [] };
    entry.regs.push(c);
    byRow.set(k, entry);
  }
  const items = new Map<string, { row: RowKey; items: ConflictItem[] }>();
  for (const [k, { row, regs }] of byRow) items.set(k, { row, items: rowItems(regs, env) });
  for (const cycle of cctx.structural) {
    const row: RowKey = { tbl: cycle.tbl, rowId: cycle.movedToRoot };
    const k = rowKeyStr(row);
    const entry = items.get(k) ?? { row, items: [] };
    entry.items.push({ kind: 'cycle', tbl: cycle.tbl, rowIds: cycle.rowIds, movedToRoot: cycle.movedToRoot });
    items.set(k, entry);
  }
  const groups = [...items.values()]
    .filter((g) => g.items.length > 0)
    .map((g) => makeGroup(state, g.row, g.items, cctx.snoozed));
  return groups.sort(compareGroups);
}

/** MCP has_conflict (7.2): any conflicted prompt/groupA register on the row. */
export function hasConflict(state: SyncState, row: RowKey, implicit: ImplicitProvider): boolean {
  const r = state.rows.get(rowKeyStr(row));
  if (!r) return false;
  for (const [name, reg] of r.regs) {
    const def = registerDef(reg.key);
    if (def && (def.cls === 'prompt' || def.cls === 'groupA') && isConflict(def, name, sibsOf(state, reg.key, implicit))) {
      return true;
    }
  }
  return false;
}
