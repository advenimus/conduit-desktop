/**
 * Reading register values from content rows and building content rows back from
 * materialized register values (spec 3.5 source columns). Import through catalog.ts.
 * Fully implemented.
 */

import { jcs, jcsObjectFromEntries } from './jcs.js';
import {
  CONFIG_PREFIX,
  CONTAINER_REG,
  FLAG_PRESENT,
  LIFE_LIVE,
  LIFE_REG,
  TAG_PREFIX,
  asBlob,
  asInt,
  asText,
  configReg,
  entryContainer,
  fixedDef,
  fixedRegisters,
  folderContainer,
  parseContainer,
  tagReg,
} from './catalog-defs.js';
import {
  TBL,
  type ContentRow,
  type ContentTbl,
  type EntryRow,
  type FolderRow,
  type HistoryRow,
  type RegisterDef,
  type SqlValue,
  type SyncValue,
} from './types.js';

// ---------- Reading content rows ----------

export interface RowRead {
  /** Every fixed register (default when default) plus present config.* and tag:* registers. */
  readonly values: ReadonlyMap<string, SyncValue>;
  /** Columns that could not be parsed ('config' or 'tags'); read as empty. */
  readonly malformed: readonly string[];
}

export function readContentRow(tbl: ContentTbl, row: ContentRow): RowRead {
  switch (tbl) {
    case TBL.entries:
      return readEntryRow(row as EntryRow);
    case TBL.folders:
      return readFolderRow(row as FolderRow);
    case TBL.history:
      return readHistoryRow(row as HistoryRow);
  }
}

export function readEntryRow(row: EntryRow): RowRead {
  const values = new Map<string, SyncValue>([
    [LIFE_REG, LIFE_LIVE],
    ['name', asText(row.name) ?? ''],
    ['entry_type', asText(row.entry_type) ?? ''],
    [CONTAINER_REG, entryContainer(row.folder_id, row.parent_entry_id)],
    ['host', asText(row.host)],
    ['port', asInt(row.port)],
    ['username', asText(row.username)],
    ['domain', asText(row.domain)],
    ['credential_type', asText(row.credential_type)],
    ['notes', asText(row.notes)],
    ['credential_id', asText(row.credential_id)],
    ['password', asBlob(row.password_encrypted)],
    ['private_key', asBlob(row.private_key_encrypted)],
    ['totp_secret', asBlob(row.totp_secret_encrypted)],
    ['icon', asText(row.icon)],
    ['color', asText(row.color)],
    ['is_favorite', asInt(row.is_favorite) ?? 0],
    ['sort_order', asInt(row.sort_order) ?? 0],
    ['created_at', asText(row.created_at)],
  ]);
  const malformed: string[] = [];
  if (!readConfigInto(values, row.config)) malformed.push('config');
  if (!readTagsInto(values, row.tags)) malformed.push('tags');
  return { values, malformed };
}

function readConfigInto(values: Map<string, SyncValue>, raw: SqlValue): boolean {
  const text = asText(raw);
  if (text === null || text.trim().length === 0) return true;
  const parsed = safeParse(text);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v !== undefined) values.set(configReg(k), jcs(v));
  }
  return true;
}

function readTagsInto(values: Map<string, SyncValue>, raw: SqlValue): boolean {
  const text = asText(raw);
  if (text === null || text.trim().length === 0) return true;
  const parsed = safeParse(text);
  if (!Array.isArray(parsed)) return false;
  for (const tag of parsed) {
    const name = typeof tag === 'string' ? tag : jcs(tag ?? null);
    if (name.length > 0) values.set(tagReg(name), FLAG_PRESENT);
  }
  return true;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function readFolderRow(row: FolderRow): RowRead {
  const values = new Map<string, SyncValue>([
    [LIFE_REG, LIFE_LIVE],
    ['name', asText(row.name) ?? ''],
    [CONTAINER_REG, folderContainer(row.parent_id)],
    ['icon', asText(row.icon)],
    ['color', asText(row.color)],
    ['sort_order', asInt(row.sort_order) ?? 0],
    ['created_at', asText(row.created_at)],
  ]);
  return { values, malformed: [] };
}

export function readHistoryRow(row: HistoryRow): RowRead {
  const values = new Map<string, SyncValue>([
    [LIFE_REG, LIFE_LIVE],
    ['entry_id', asText(row.entry_id)],
    ['username', asText(row.username)],
    ['password', asBlob(row.password_encrypted)],
    ['changed_at', asText(row.changed_at)],
    ['changed_by', asText(row.changed_by)],
  ]);
  return { values, malformed: [] };
}

/** Synced vault_meta registers (vault_id, cloud_sync_enabled) from the vault_meta table. */
export function readMetaRegisters(meta: ReadonlyMap<string, string>): ReadonlyMap<string, SyncValue> {
  return new Map(fixedRegisters(TBL.meta).map((d) => [d.reg, meta.get(d.reg) ?? null] as const));
}

// ---------- Building content rows ----------

function valueFor(d: RegisterDef, values: ReadonlyMap<string, SyncValue>): SyncValue {
  const v = values.has(d.reg) ? (values.get(d.reg) as SyncValue) : d.defaultValue;
  if (v === null && d.notNullFallback !== null) return d.notNullFallback;
  return v;
}

function familyEntries(values: ReadonlyMap<string, SyncValue>, prefix: string): Array<readonly [string, SyncValue]> {
  const out: Array<readonly [string, SyncValue]> = [];
  for (const [reg, v] of values) {
    if (reg.startsWith(prefix) && v !== null) out.push([reg.slice(prefix.length), v]);
  }
  return out;
}

/** config column text: JCS object of every present `config.<key>` register. */
export function buildConfigText(values: ReadonlyMap<string, SyncValue>): string {
  return jcsObjectFromEntries(familyEntries(values, CONFIG_PREFIX).map(([k, v]) => [k, String(v)] as const));
}

/** tags column text: sorted set of present `tag:<value>` registers. */
export function buildTagsText(values: ReadonlyMap<string, SyncValue>): string {
  return JSON.stringify(familyEntries(values, TAG_PREFIX).map(([k]) => k).sort());
}

function containerColumns(v: SyncValue): { folder: string | null; parent: string | null } {
  const ref = parseContainer(v);
  if (!ref || ref.kind === 'r') return { folder: null, parent: null };
  return ref.kind === 'f' ? { folder: ref.id, parent: null } : { folder: null, parent: ref.id };
}

const text = (v: SyncValue): string | null => asText(v);
const blob = (v: SyncValue): Uint8Array | null => asBlob(v);
const int = (v: SyncValue): number | string | null => asInt(v);

/**
 * Builds a content row from MATERIALIZED register values (missing fixed registers take their
 * default; NOT NULL columns take the catalog fallback). `updatedAt` is ignored for history rows.
 */
export function buildContentRow(
  tbl: ContentTbl,
  rowId: string,
  values: ReadonlyMap<string, SyncValue>,
  updatedAt: string,
): ContentRow {
  const v = (reg: string): SyncValue => valueFor(fixedDef(tbl, reg), values);
  if (tbl === TBL.history) {
    return {
      id: rowId,
      entry_id: text(v('entry_id')),
      username: text(v('username')),
      password_encrypted: blob(v('password')),
      changed_at: text(v('changed_at')),
      changed_by: text(v('changed_by')),
    } satisfies HistoryRow;
  }
  if (tbl === TBL.folders) {
    return {
      id: rowId,
      name: text(v('name')),
      parent_id: containerColumns(v(CONTAINER_REG)).folder,
      sort_order: int(v('sort_order')),
      icon: text(v('icon')),
      color: text(v('color')),
      created_at: text(v('created_at')),
      updated_at: updatedAt,
    } satisfies FolderRow;
  }
  return buildEntryRow(rowId, v, values, updatedAt);
}

function buildEntryRow(
  rowId: string,
  v: (reg: string) => SyncValue,
  values: ReadonlyMap<string, SyncValue>,
  updatedAt: string,
): EntryRow {
  const container = containerColumns(v(CONTAINER_REG));
  return {
    id: rowId,
    name: text(v('name')),
    entry_type: text(v('entry_type')),
    folder_id: container.folder,
    parent_entry_id: container.parent,
    sort_order: int(v('sort_order')),
    host: text(v('host')),
    port: int(v('port')),
    credential_id: text(v('credential_id')),
    username: text(v('username')),
    password_encrypted: blob(v('password')),
    domain: text(v('domain')),
    private_key_encrypted: blob(v('private_key')),
    totp_secret_encrypted: blob(v('totp_secret')),
    icon: text(v('icon')),
    color: text(v('color')),
    credential_type: text(v('credential_type')),
    config: buildConfigText(values),
    tags: buildTagsText(values),
    is_favorite: int(v('is_favorite')),
    notes: text(v('notes')),
    created_at: text(v('created_at')),
    updated_at: updatedAt,
  };
}
