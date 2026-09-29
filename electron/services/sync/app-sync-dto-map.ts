/**
 * Conversions between the core sync shapes and the IPC payloads of app-sync-dto.ts (plain
 * JSON: no Map, no bytes, secrets masked), and validation of every key and choice the renderer
 * sends (system boundary: anything malformed is rejected with InvalidSyncRequest).
 */

import { deviceNamesFromPresence } from './conflicts.js';
import { TBL } from './types.js';
import type {
  CandidatePreview,
  ConflictGroup,
  ConflictItem,
  ConflictVersion,
  DeletedItem,
  FieldChoice,
  FieldConflict,
  PreviewField,
  PreviewRow,
  RegKey,
  RowKey,
  SyncState,
  SyncValue,
  Tbl,
} from './types.js';
import type { RollbackPreview } from './restore.js';
import type { UndoPreview } from './snapshots.js';
import type * as Dto from './app-sync-dto.js';
import type { OwnershipView } from '../vault-session/session-runtime.js';

const TABLES: ReadonlySet<number> = new Set(Object.values(TBL));
const MAX_ID_LEN = 512;

/** A request from the renderer that does not have the expected shape. */
export class InvalidSyncRequest extends Error {
  constructor(what: string) {
    super(`Invalid sync request: ${what}`);
    this.name = 'InvalidSyncRequest';
  }
}

// ---------- Renderer -> core ----------

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '' || v.length > MAX_ID_LEN) throw new InvalidSyncRequest(what);
  return v;
}

export function toRowKey(v: unknown): RowKey {
  if (!isRecord(v) || typeof v.tbl !== 'number' || !TABLES.has(v.tbl)) throw new InvalidSyncRequest('row');
  return { tbl: v.tbl as Tbl, rowId: requireString(v.rowId, 'row id') };
}

export function toRegKey(v: unknown): RegKey {
  const row = toRowKey(v);
  return { ...row, reg: requireString((v as Record<string, unknown>).reg, 'field') };
}

export function toRowKeys(v: unknown): RowKey[] {
  if (!Array.isArray(v)) throw new InvalidSyncRequest('rows');
  return v.map(toRowKey);
}

export function toRegKeys(v: unknown): RegKey[] {
  if (!Array.isArray(v)) throw new InvalidSyncRequest('fields');
  return v.map(toRegKey);
}

function toStringRecord(v: unknown, what: string): ReadonlyMap<string, string> {
  if (!isRecord(v)) throw new InvalidSyncRequest(what);
  return new Map(Object.entries(v).map(([k, x]) => [requireString(k, what), requireString(x, what)] as const));
}

export function toFieldChoice(v: unknown): FieldChoice {
  if (!isRecord(v)) throw new InvalidSyncRequest('choice');
  if (v.kind === 'version') return { kind: 'version', versionId: requireString(v.versionId, 'version') };
  if (v.kind === 'keep-both') return { kind: 'keep-both', copyNames: toStringRecord(v.copyNames, 'copy names') };
  if (v.kind === 'value') {
    const value = v.value;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') throw new InvalidSyncRequest('value');
    const plaintext = v.plaintext === undefined || v.plaintext === null ? null : requireText(v.plaintext);
    return { kind: 'value', value, plaintext };
  }
  throw new InvalidSyncRequest('choice kind');
}

function requireText(v: unknown): string {
  if (typeof v !== 'string') throw new InvalidSyncRequest('text');
  return v;
}

export function toAppearanceChoices(v: unknown): 'keep-newest' | ReadonlyMap<string, string> {
  return v === 'keep-newest' ? 'keep-newest' : toStringRecord(v, 'appearance choices');
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new InvalidSyncRequest(what);
  return v as T;
}

// ---------- Core -> renderer ----------

function valueDto(v: SyncValue): { readonly value: Dto.SyncValueDto; readonly binary: boolean } {
  if (v instanceof Uint8Array) return { value: null, binary: true };
  return { value: v, binary: false };
}

function rowDto(k: RowKey): Dto.SyncRowKey {
  return { tbl: k.tbl, rowId: k.rowId };
}

function regDto(k: RegKey): Dto.SyncRegKey {
  return { tbl: k.tbl, rowId: k.rowId, reg: k.reg };
}

export function versionDto(v: ConflictVersion): Dto.ConflictVersion {
  const { value, binary } = valueDto(v.value);
  return {
    id: v.id,
    source: v.source,
    timeMs: v.timeMs,
    value,
    masked: v.masked || binary,
    provisional: v.provisional,
    undecryptable: v.undecryptable,
    redacted: v.redacted,
    olderApp: v.pseudo,
  };
}

function fieldDto(f: FieldConflict): Dto.FieldConflict {
  return {
    key: regDto(f.key),
    label: f.label,
    cls: f.cls,
    secret: f.secret,
    versions: f.versions.map(versionDto),
    staleRevert: f.staleRevert,
    keepBothOffered: f.keepBothOffered,
    invariantGuard: f.invariantGuard,
    snoozeKey: f.snoozeKey,
  };
}

function itemDto(item: ConflictItem): Dto.ConflictItem {
  switch (item.kind) {
    case 'field':
    case 'undecryptable':
      return { kind: item.kind, field: fieldDto(item.field) };
    case 'appearance':
      return {
        kind: 'appearance',
        row: rowDto(item.row),
        fields: item.fields.map(fieldDto),
        newest: Object.fromEntries(item.newest),
        snoozeKey: item.snoozeKey,
      };
    case 'edit-delete':
      return {
        kind: 'edit-delete',
        row: rowDto(item.row),
        deleted: item.deleted.map(versionDto),
        edited: item.edited.map(versionDto),
        snoozeKey: item.snoozeKey,
      };
    case 'folder-delete':
      return {
        kind: 'folder-delete',
        folder: rowDto(item.folder),
        deleted: item.deleted.map(versionDto),
        changedItems: item.changedItems.map(rowDto),
        snoozeKey: item.snoozeKey,
      };
    case 'cycle':
      return { kind: 'cycle', tbl: item.tbl, rowIds: [...item.rowIds], movedToRoot: item.movedToRoot };
    case 'epoch':
      return { kind: 'epoch', versions: item.versions.map(versionDto) };
  }
}

export function groupDto(g: ConflictGroup): Dto.ConflictGroup {
  return { row: rowDto(g.row), title: g.title, items: g.items.map(itemDto), snoozed: g.snoozed };
}

function previewFieldDto(f: PreviewField): Dto.CandidatePreviewField {
  const cur = valueDto(f.current);
  const inc = valueDto(f.incoming);
  return {
    key: regDto(f.key),
    label: f.label,
    rowTitle: f.rowTitle,
    current: cur.value,
    incoming: inc.value,
    masked: f.masked || cur.binary || inc.binary,
  };
}

function previewRowDto(r: PreviewRow): Dto.CandidatePreviewRow {
  return { row: rowDto(r.row), title: r.title };
}

export function candidatePreviewDto(id: string, p: CandidatePreview): Dto.CandidatePreview {
  return {
    id,
    kind: p.kind,
    source: p.source,
    label: p.label,
    changedFields: p.changedFields.map(previewFieldDto),
    onlyInCopy: p.onlyInCopy.map(previewRowDto),
    missingFromCopy: p.missingFromCopy.map(previewRowDto),
    deletions: p.deletions.map(previewRowDto),
    needsReview: p.needsReview,
  };
}

export function rollbackPreviewDto(p: RollbackPreview): Dto.RollbackPreview {
  return {
    deletions: p.deletions.map(previewRowDto),
    restorations: p.restorations.map(previewRowDto),
    replacements: p.replacements.map(previewFieldDto),
    unreadableSecrets: p.unreadableSecrets,
  };
}

export function undoPreviewDto(p: UndoPreview): Dto.UndoPreview {
  return {
    snapshotId: p.snapshotId,
    rows: p.rows.map((r) => ({ row: rowDto(r.row), title: r.title, stillDeleted: r.stillDeleted })),
    fields: p.fields.map((f) => ({ key: regDto(f.key), label: f.label, stillMerged: f.stillMerged, secret: f.secret })),
  };
}

/** dev -> device name through sync_dev and presence (null when unknown). */
export function deviceNameOfDev(state: SyncState, dev: number, names: ReadonlyMap<string, string>): string | null {
  const uuid = state.devs.get(dev)?.deviceUuid;
  return uuid === undefined ? null : names.get(uuid) ?? null;
}

export function deviceNameOfUuid(state: SyncState, uuid: string | null): string | null {
  return uuid === null ? null : deviceNamesFromPresence(state).get(uuid) ?? null;
}

export function deletedDto(state: SyncState, items: readonly DeletedItem[]): Dto.RecentlyDeletedItem[] {
  const names = deviceNamesFromPresence(state);
  return items.map((d) => ({
    row: rowDto(d.row),
    title: d.title,
    entryType: d.entryType,
    diedMs: d.diedMs,
    deviceName: deviceNameOfDev(state, d.diedDev, names),
    redacted: d.redacted,
  }));
}

/** Plan enforcement 4.7: the runtime's last confirmed answer; 'unknown' signed out, soft-locked or unconfirmed. */
export function ownershipDto(view: OwnershipView, signedIn: boolean, softLocked: boolean): Dto.VaultOwnership {
  if (!signedIn || softLocked || !view.confirmed || view.ownership === null) return { kind: 'unknown' };
  return view.ownership;
}
