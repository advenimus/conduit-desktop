/**
 * Register catalog definitions (spec 3.5): register names, class, value kind, default,
 * secret flag, source columns, key constructors, implicit siblings, value normalization and
 * container helpers. Import through catalog.ts. Fully implemented.
 */

import {
  TBL,
  ZERO_PID,
  type ContentTbl,
  type Pmem,
  type RegClass,
  type RegFamily,
  type RegKey,
  type RegisterDef,
  type RowKey,
  type Sibling,
  type SqlValue,
  type SyncValue,
  type Tbl,
  type ValueKind,
} from './types.js';

export const LIFE_REG = '_life';
export const LIFE_LIVE = 'live';
export const LIFE_DEAD = 'dead';
export const CONTAINER_REG = 'container';
export const CONTAINER_ROOT = 'r';
export const CONFIG_PREFIX = 'config.';
export const TAG_PREFIX = 'tag:';
export const DOCUMENT_CONTENT_REG = 'config.content';
export const DOCUMENT_TYPE = 'document';
export const CREDENTIAL_TYPE = 'credential';
export const FLAG_PRESENT = 1;
export const EPOCH_ZERO_ISO = '1970-01-01T00:00:00.000Z';

/** Row id of the single vault_meta pseudo-row (tbl 4). */
export const META_ROW_ID = 'meta';
/** Row ids of `_sync` (tbl 9); the spec's `key/epoch` is row 'key', register 'epoch'. */
export const SYNC_ROW = { key: 'key', owner: 'owner', dismiss: 'dismiss', device: 'device' } as const;
export const EPOCH_REG = 'epoch';
export const OWNER_REG = 'owner';
/** `_sync/owner/account`: the in-file owner tag (plan enforcement 3.1), next to the Free owner claim. */
export const ACCOUNT_REG = 'account';

export const TABLE_NAME: Readonly<Record<ContentTbl, string>> = { 1: 'entries', 2: 'folders', 3: 'password_history' };
export const CONTENT_TBLS: readonly ContentTbl[] = [TBL.entries, TBL.folders, TBL.history];

export const KEY_SOURCE_PASSWORD = 'password';

/** Every column of each content table, in schema order (SELECT and UPSERT lists). */
export const CONTENT_COLUMNS: Readonly<Record<ContentTbl, readonly string[]>> = {
  1: [
    'id', 'name', 'entry_type', 'folder_id', 'parent_entry_id', 'sort_order', 'host', 'port',
    'credential_id', 'username', 'password_encrypted', 'domain', 'private_key_encrypted',
    'totp_secret_encrypted', 'icon', 'color', 'credential_type', 'config', 'tags', 'is_favorite',
    'notes', 'created_at', 'updated_at',
  ],
  2: ['id', 'name', 'parent_id', 'sort_order', 'icon', 'color', 'created_at', 'updated_at'],
  3: ['id', 'entry_id', 'username', 'password_encrypted', 'changed_at', 'changed_by'],
};

/** raw_hash column order (3.6): every catalog column except `id` and `updated_at`. */
export const RAW_HASH_COLUMNS: Readonly<Record<ContentTbl, readonly string[]>> = {
  1: CONTENT_COLUMNS[1].filter((c) => c !== 'id' && c !== 'updated_at'),
  2: CONTENT_COLUMNS[2].filter((c) => c !== 'id' && c !== 'updated_at'),
  3: CONTENT_COLUMNS[3].filter((c) => c !== 'id'),
};

interface DefOptions {
  readonly family?: RegFamily;
  readonly secret?: boolean;
  readonly defaultValue?: SyncValue;
  readonly columns?: readonly string[];
  readonly notNullFallback?: SyncValue;
  readonly references?: 'entry';
  readonly label: string;
}

function def(tbl: Tbl, reg: string, kind: ValueKind, cls: RegClass, o: DefOptions): RegisterDef {
  return Object.freeze({
    tbl,
    reg,
    family: o.family ?? null,
    cls,
    kind,
    secret: o.secret ?? false,
    defaultValue: o.defaultValue ?? null,
    columns: o.columns ?? [reg],
    notNullFallback: o.notNullFallback ?? null,
    references: o.references ?? null,
    label: o.label,
  });
}

const life = (tbl: Tbl, cls: RegClass): RegisterDef =>
  def(tbl, LIFE_REG, 'life', cls, { defaultValue: LIFE_LIVE, columns: [], label: 'Item' });

const ENTRY_DEFS: readonly RegisterDef[] = [
  life(TBL.entries, 'prompt'),
  def(TBL.entries, 'name', 'reqtext', 'prompt', { defaultValue: '', notNullFallback: '', label: 'Name' }),
  def(TBL.entries, 'entry_type', 'reqtext', 'prompt', { defaultValue: '', notNullFallback: DOCUMENT_TYPE, label: 'Type' }),
  def(TBL.entries, CONTAINER_REG, 'container', 'prompt', {
    defaultValue: CONTAINER_ROOT,
    columns: ['folder_id', 'parent_entry_id'],
    label: 'Location',
  }),
  def(TBL.entries, 'host', 'text', 'prompt', { label: 'Host' }),
  def(TBL.entries, 'port', 'int', 'prompt', { label: 'Port' }),
  def(TBL.entries, 'username', 'text', 'prompt', { label: 'Username' }),
  def(TBL.entries, 'domain', 'text', 'prompt', { label: 'Domain' }),
  def(TBL.entries, 'credential_type', 'text', 'prompt', { label: 'Credential type' }),
  def(TBL.entries, 'notes', 'text', 'prompt', { label: 'Notes' }),
  def(TBL.entries, 'credential_id', 'ref', 'prompt', { references: 'entry', label: 'Linked credential' }),
  def(TBL.entries, 'password', 'secret', 'prompt', { secret: true, columns: ['password_encrypted'], label: 'Password' }),
  def(TBL.entries, 'private_key', 'secret', 'prompt', { secret: true, columns: ['private_key_encrypted'], label: 'Private key' }),
  def(TBL.entries, 'totp_secret', 'secret', 'prompt', { secret: true, columns: ['totp_secret_encrypted'], label: 'TOTP secret' }),
  def(TBL.entries, 'icon', 'text', 'groupA', { label: 'Icon' }),
  def(TBL.entries, 'color', 'text', 'groupA', { label: 'Color' }),
  def(TBL.entries, 'is_favorite', 'int0', 'groupA', { defaultValue: 0, notNullFallback: 0, label: 'Favorite' }),
  def(TBL.entries, 'sort_order', 'int0', 'auto', { defaultValue: 0, notNullFallback: 0, label: 'Sort order' }),
  def(TBL.entries, 'created_at', 'time', 'auto', { notNullFallback: EPOCH_ZERO_ISO, label: 'Created' }),
];

const CONFIG_DEF = def(TBL.entries, CONFIG_PREFIX, 'json', 'prompt', { family: 'config', columns: ['config'], label: 'Setting' });
const TAG_DEF = def(TBL.entries, TAG_PREFIX, 'flag', 'groupA', { family: 'tag', columns: ['tags'], label: 'Tag' });

const FOLDER_DEFS: readonly RegisterDef[] = [
  life(TBL.folders, 'prompt'),
  def(TBL.folders, 'name', 'reqtext', 'prompt', { defaultValue: '', notNullFallback: '', label: 'Name' }),
  def(TBL.folders, CONTAINER_REG, 'container', 'prompt', { defaultValue: CONTAINER_ROOT, columns: ['parent_id'], label: 'Location' }),
  def(TBL.folders, 'icon', 'text', 'groupA', { label: 'Icon' }),
  def(TBL.folders, 'color', 'text', 'groupA', { label: 'Color' }),
  def(TBL.folders, 'sort_order', 'int0', 'auto', { defaultValue: 0, notNullFallback: 0, label: 'Sort order' }),
  def(TBL.folders, 'created_at', 'time', 'auto', { notNullFallback: EPOCH_ZERO_ISO, label: 'Created' }),
];

const HISTORY_DEFS: readonly RegisterDef[] = [
  life(TBL.history, 'auto'),
  def(TBL.history, 'entry_id', 'ref', 'auto', { references: 'entry', label: 'Entry' }),
  def(TBL.history, 'username', 'text', 'auto', { label: 'Username' }),
  def(TBL.history, 'password', 'secret', 'auto', { secret: true, columns: ['password_encrypted'], label: 'Password' }),
  def(TBL.history, 'changed_at', 'time', 'auto', { notNullFallback: EPOCH_ZERO_ISO, label: 'Changed' }),
  def(TBL.history, 'changed_by', 'text', 'auto', { label: 'Changed by' }),
];

const META_DEFS: readonly RegisterDef[] = [
  def(TBL.meta, 'vault_id', 'text', 'auto', { label: 'Vault id' }),
  def(TBL.meta, 'cloud_sync_enabled', 'text', 'auto', { label: 'Cloud backup' }),
];

const EPOCH_DEF = def(TBL.sync, EPOCH_REG, 'text', 'special', { columns: [], label: 'Master password' });
const OWNER_DEF = def(TBL.sync, OWNER_REG, 'json', 'auto', { columns: [], label: 'Owner claim' });
const ACCOUNT_DEF = def(TBL.sync, ACCOUNT_REG, 'json', 'auto', { columns: [], label: 'Vault owner' });
const DISMISS_DEF = def(TBL.sync, '', 'flag', 'auto', { family: 'dismiss', columns: [], label: 'Dismissed suggestion' });
const DEVICE_DEF = def(TBL.sync, '', 'json', 'auto', { family: 'device', columns: [], label: 'Device' });

const FIXED: Readonly<Record<number, ReadonlyMap<string, RegisterDef>>> = {
  [TBL.entries]: new Map(ENTRY_DEFS.map((d) => [d.reg, d])),
  [TBL.folders]: new Map(FOLDER_DEFS.map((d) => [d.reg, d])),
  [TBL.history]: new Map(HISTORY_DEFS.map((d) => [d.reg, d])),
  [TBL.meta]: new Map(META_DEFS.map((d) => [d.reg, d])),
};

/** Fixed (non-family) registers of a table, in catalog order. `_sync` has none. */
export function fixedRegisters(tbl: Tbl): readonly RegisterDef[] {
  switch (tbl) {
    case TBL.entries:
      return ENTRY_DEFS;
    case TBL.folders:
      return FOLDER_DEFS;
    case TBL.history:
      return HISTORY_DEFS;
    case TBL.meta:
      return META_DEFS;
    default:
      return [];
  }
}

/** Catalog lookup; null for registers outside the catalog (never synced). */
export function registerDef(key: RegKey): RegisterDef | null {
  if (key.tbl === TBL.sync) return syncRegisterDef(key.rowId, key.reg);
  const fixed = FIXED[key.tbl]?.get(key.reg);
  if (fixed) return fixed;
  if (key.tbl !== TBL.entries) return null;
  if (key.reg.startsWith(CONFIG_PREFIX) && key.reg.length > CONFIG_PREFIX.length) return CONFIG_DEF;
  if (key.reg.startsWith(TAG_PREFIX) && key.reg.length > TAG_PREFIX.length) return TAG_DEF;
  return null;
}

function syncRegisterDef(rowId: string, reg: string): RegisterDef | null {
  if (rowId === SYNC_ROW.key) return reg === EPOCH_REG ? EPOCH_DEF : null;
  if (rowId === SYNC_ROW.owner) return reg === OWNER_REG ? OWNER_DEF : reg === ACCOUNT_REG ? ACCOUNT_DEF : null;
  if (reg.length === 0) return null;
  if (rowId === SYNC_ROW.dismiss) return DISMISS_DEF;
  if (rowId === SYNC_ROW.device) return DEVICE_DEF;
  return null;
}

/** A fixed register of a content or meta table; throws when absent. */
export function fixedDef(tbl: Tbl, reg: string): RegisterDef {
  const d = FIXED[tbl]?.get(reg);
  if (!d) throw new Error(`sync catalog: no fixed register ${tbl}/${reg}`);
  return d;
}

export function requireDef(key: RegKey): RegisterDef {
  const d = registerDef(key);
  if (!d) throw new Error(`sync catalog: unknown register ${key.tbl}/${key.rowId}/${key.reg}`);
  return d;
}

export function isContentTbl(tbl: Tbl): tbl is ContentTbl {
  return tbl === TBL.entries || tbl === TBL.folders || tbl === TBL.history;
}

// ---------- Key constructors ----------

export function rowKey(tbl: Tbl, rowId: string): RowKey {
  return { tbl, rowId };
}

export function regKey(tbl: Tbl, rowId: string, reg: string): RegKey {
  return { tbl, rowId, reg };
}

export const metaRegKey = (reg: 'vault_id' | 'cloud_sync_enabled'): RegKey => regKey(TBL.meta, META_ROW_ID, reg);
export const epochRegKey = (): RegKey => regKey(TBL.sync, SYNC_ROW.key, EPOCH_REG);
export const ownerRegKey = (): RegKey => regKey(TBL.sync, SYNC_ROW.owner, OWNER_REG);
export const ownerTagRegKey = (): RegKey => regKey(TBL.sync, SYNC_ROW.owner, ACCOUNT_REG);
export const dismissRegKey = (hash: string): RegKey => regKey(TBL.sync, SYNC_ROW.dismiss, hash);
export const deviceRegKey = (deviceUuid: string): RegKey => regKey(TBL.sync, SYNC_ROW.device, deviceUuid);
export const configReg = (configKey: string): string => CONFIG_PREFIX + configKey;
export const tagReg = (tag: string): string => TAG_PREFIX + tag;

// ---------- Implicit registers (3.4) ----------

export const IMPLICIT_PMEM: Pmem = Object.freeze({ ms: 0, ids: Object.freeze([ZERO_PID]) as readonly string[] });

/** The implicit genesis sibling; `vhash` must be the hash of the default value (hashing.ts). */
export function implicitSiblingOf(key: RegKey, vhash: string): Sibling {
  return {
    dev: 0,
    ms: 0,
    c: 0,
    pid: ZERO_PID,
    lt: 0,
    vhash,
    flags: 0,
    value: requireDef(key).defaultValue,
    prevVhash: null,
  };
}

// ---------- Value normalization ----------

const INT_TEXT = /^-?\d+$/;

export function asText(v: SqlValue | SyncValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return Buffer.from(v).toString('utf8');
}

export function asInt(v: SqlValue | SyncValue): number | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const text = asText(v);
  if (text === null || text.trim().length === 0) return null;
  return INT_TEXT.test(text.trim()) ? Number(text.trim()) : text;
}

export function asBlob(v: SqlValue | SyncValue): Uint8Array | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return v.length === 0 ? null : v;
  const text = asText(v);
  return text === null || text.length === 0 ? null : Buffer.from(text, 'utf8');
}

/**
 * Brings a value to its canonical JS form for its kind, so equality of normalized values
 * equals equality of canon() bytes for every kind except `time` (which canonical.ts parses).
 */
export function normalizeValue(d: RegisterDef, v: SyncValue): SyncValue {
  switch (d.kind) {
    case 'text':
    case 'ref': {
      const t = asText(v);
      return t === null || t.length === 0 ? null : t;
    }
    case 'reqtext':
    case 'life':
    case 'container':
    case 'json':
    case 'time':
      return asText(v);
    case 'int':
      return asInt(v);
    case 'int0':
      return asInt(v) ?? 0;
    case 'flag':
      return v === null || v === 0 || v === '' ? null : FLAG_PRESENT;
    case 'secret':
      return asBlob(v);
  }
}

export function isDefaultValue(d: RegisterDef, v: SyncValue): boolean {
  const n = normalizeValue(d, v);
  const dv = normalizeValue(d, d.defaultValue);
  if (n instanceof Uint8Array || dv instanceof Uint8Array) return n === dv;
  return n === dv;
}

// ---------- Containers ----------

export type ContainerRef = { readonly kind: 'r' } | { readonly kind: 'f' | 'e'; readonly id: string };

export function parseContainer(v: SyncValue): ContainerRef | null {
  if (v === CONTAINER_ROOT) return { kind: 'r' };
  if (typeof v !== 'string' || v.length < 3 || v[1] !== ':') return null;
  const kind = v[0];
  return kind === 'f' || kind === 'e' ? { kind, id: v.slice(2) } : null;
}

export function formatContainer(ref: ContainerRef): string {
  return ref.kind === 'r' ? CONTAINER_ROOT : `${ref.kind}:${ref.id}`;
}

/** The row a container value points at: 'f:X' -> folder X, 'e:Y' -> entry Y, root -> null. */
export function containerTarget(v: SyncValue): RowKey | null {
  const ref = parseContainer(v);
  if (!ref || ref.kind === 'r') return null;
  return rowKey(ref.kind === 'f' ? TBL.folders : TBL.entries, ref.id);
}

/** `e:` wins when a legacy row has both columns set, matching deleteEntry. */
export function entryContainer(folderId: SqlValue, parentEntryId: SqlValue): string {
  const parent = asText(parentEntryId);
  if (parent) return `e:${parent}`;
  const folder = asText(folderId);
  return folder ? `f:${folder}` : CONTAINER_ROOT;
}

export function folderContainer(parentId: SqlValue): string {
  const parent = asText(parentId);
  return parent ? `f:${parent}` : CONTAINER_ROOT;
}

// ---------- Rule R and legacy-rule helpers ----------

/** Rows a live row references (rule R): an entry's credential_id, a history row's entry_id. */
export function referencedRows(tbl: Tbl, values: ReadonlyMap<string, SyncValue>): RowKey[] {
  const reg = tbl === TBL.entries ? 'credential_id' : tbl === TBL.history ? 'entry_id' : null;
  if (reg === null) return [];
  const id = asText(values.get(reg) ?? null);
  return id ? [rowKey(TBL.entries, id)] : [];
}

/** Drop rule (4.3): an "empty" config value an older app writes when it rebuilds config. */
export function isEmptyConfigValue(v: SyncValue): boolean {
  return v === null || v === '[]' || v === '{}' || v === '""';
}

export function isDocumentContent(key: RegKey, entryType: SyncValue): boolean {
  return key.tbl === TBL.entries && key.reg === DOCUMENT_CONTENT_REG && entryType === DOCUMENT_TYPE;
}

/** UI label for any register, including dynamic families. */
export function registerLabel(key: RegKey): string {
  const d = registerDef(key);
  if (!d) return key.reg;
  if (key.reg === DOCUMENT_CONTENT_REG) return 'Document';
  if (d.family === 'config') return `Setting "${key.reg.slice(CONFIG_PREFIX.length)}"`;
  if (d.family === 'tag') return `Tag "${key.reg.slice(TAG_PREFIX.length)}"`;
  return d.label;
}
