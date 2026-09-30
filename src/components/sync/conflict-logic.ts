/**
 * Pure helpers for the conflict review UI (spec 7.2, 7.3): value display, choices and the
 * requests sent to sync_resolve / sync_resolve_group.
 */

import type {
  ConflictItem,
  ConflictVersion,
  FieldChoiceDto,
  FieldConflict,
  ResolveGroupRequest,
  SyncValueDto,
} from "../../types/sync";
import { deviceNameOr, formatDateTime, formatShortDate, versionSourceLabel } from "./sync-copy";

export const MASKED_VALUE = "••••••••";
const MAX_INLINE_VALUE = 120;
const ENTRY_TBL = 1;
const CONFIG_PREFIX = "config.";
const TAG_PREFIX = "tag:";
const CONTAINER_ROOT = "r";
const LONG_TEXT_REGS: ReadonlySet<string> = new Set(["notes", "config.content"]);
const REF_REGS: ReadonlySet<string> = new Set(["credential_id", "entry_id"]);

/** Finds a folder or item name for Location and Linked credential values. */
export type NameLookup = (kind: "folder" | "entry", id: string) => string | undefined;

type FieldKind = "json" | "container" | "ref" | "flag" | "favorite" | "plain";

type AppearanceItem = Extract<ConflictItem, { kind: "appearance" }>;
type EditDeleteItem = Extract<ConflictItem, { kind: "edit-delete" }>;
type FolderDeleteItem = Extract<ConflictItem, { kind: "folder-delete" }>;
type CycleItem = Extract<ConflictItem, { kind: "cycle" }>;

/** A version the user can pick: not undecryptable and not erased. */
export function canUseVersion(v: ConflictVersion): boolean {
  return !v.undecryptable && !v.redacted;
}

/** What to show for a version's value (secrets stay masked until revealed). */
export function displayValue(v: ConflictVersion, revealed?: string | null): string {
  if (v.redacted) return "Erased";
  if (v.undecryptable) return "Needs your old password";
  if (v.masked) return revealed ?? MASKED_VALUE;
  return formatValue(v.value);
}

export function formatValue(value: SyncValueDto, full = false): string {
  if (value === null || value === "") return "(empty)";
  const text = String(value);
  return !full && text.length > MAX_INLINE_VALUE ? `${text.slice(0, MAX_INLINE_VALUE)}...` : text;
}

function fieldKind(field: FieldConflict): FieldKind {
  const reg = field.key.reg;
  if (field.key.tbl === ENTRY_TBL && reg.startsWith(CONFIG_PREFIX)) return "json";
  if (reg === "container") return "container";
  if (REF_REGS.has(reg)) return "ref";
  if (reg.startsWith(TAG_PREFIX)) return "flag";
  return reg === "is_favorite" ? "favorite" : "plain";
}

/** Settings are stored as JSON text; a JSON string is shown as its plain text. */
export function decodeJsonText(value: SyncValueDto): SyncValueDto {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

/** Notes and document content: full text with line breaks, never cut short. */
export function isLongTextField(field: FieldConflict): boolean {
  return field.key.tbl === ENTRY_TBL && LONG_TEXT_REGS.has(field.key.reg);
}

function containerText(value: SyncValueDto, names?: NameLookup): string {
  if (value === null || value === CONTAINER_ROOT) return "Top level";
  const [kind, id] = String(value).split(":", 2);
  if (!id) return "Another place";
  const name = names?.(kind === "f" ? "folder" : "entry", id);
  if (name === undefined) return kind === "f" ? "Another folder" : "Inside another item";
  return kind === "f" ? `Folder '${name}'` : `Inside '${name}'`;
}

function valueText(field: FieldConflict, value: SyncValueDto, names?: NameLookup): string {
  const full = isLongTextField(field);
  switch (fieldKind(field)) {
    case "json":
      return formatValue(decodeJsonText(value), full);
    case "container":
      return containerText(value, names);
    case "ref":
      return value === null || value === "" ? "(none)" : (names?.("entry", String(value)) ?? "Another item");
    case "flag":
      return value === 1 ? "Tagged" : "Not tagged";
    case "favorite":
      return value === 1 ? "Yes" : "No";
    default:
      return formatValue(value, full);
  }
}

/** A version's value in words: secrets masked, settings decoded, places and links by name. */
export function versionText(field: FieldConflict, v: ConflictVersion, revealed?: string | null, names?: NameLookup): string {
  if (v.redacted || v.undecryptable || v.masked) return displayValue(v, revealed);
  return valueText(field, v.value, names);
}

/** [Enter a different value...] only where free text makes sense (not places, links or flags). */
export function offersEnteredValue(field: FieldConflict): boolean {
  const kind = fieldKind(field);
  return kind === "plain" || kind === "json";
}

/** "Chris's iPhone, Sep 24, 10:02" */
export function versionCaption(v: ConflictVersion): string {
  const who = versionSourceLabel(v.source);
  return v.timeMs > 0 ? `${who}, ${formatDateTime(v.timeMs)}` : who;
}

export function versionChoice(v: ConflictVersion): FieldChoiceDto {
  return { kind: "version", versionId: v.id };
}

/** Numeric registers (port, favorite) take a number; everything else text. */
export function isNumericField(field: FieldConflict): boolean {
  const known = field.versions.filter((v) => !v.masked && v.value !== null);
  return known.length > 0 && known.every((v) => typeof v.value === "number");
}

export type EnteredValue = { readonly ok: true; readonly choice: FieldChoiceDto } | { readonly ok: false; readonly error: string };

/** Text settings (every known version a JSON string) take typed text; other settings take JSON. */
function jsonChoice(field: FieldConflict, raw: string): EnteredValue {
  const known = field.versions.filter((v) => !v.masked && v.value !== null);
  const textual = known.every((v) => typeof decodeJsonText(v.value) === "string" && decodeJsonText(v.value) !== v.value);
  if (textual) return { ok: true, choice: { kind: "value", value: JSON.stringify(raw) } };
  try {
    JSON.parse(raw);
    return { ok: true, choice: { kind: "value", value: raw } };
  } catch {
    return { ok: false, error: "Enter a valid JSON value." };
  }
}

/** [Enter a different value...] as the choice to send, or why the text cannot be used. */
export function enteredValueChoice(field: FieldConflict, raw: string): EnteredValue {
  if (field.secret) return { ok: true, choice: { kind: "value", value: null, plaintext: raw } };
  if (fieldKind(field) === "json") return jsonChoice(field, raw);
  if (!isNumericField(field)) return { ok: true, choice: { kind: "value", value: raw } };
  if (raw.trim() === "") return { ok: true, choice: { kind: "value", value: null } };
  const n = Number(raw);
  return Number.isInteger(n) ? { ok: true, choice: { kind: "value", value: n } } : { ok: false, error: "Enter a whole number." };
}

/** [Keep both]: one copy per other usable version, named "Doc (from iPhone)". */
export function keepBothCopyNames(title: string, field: FieldConflict): Record<string, string> {
  const names: Record<string, string> = {};
  const used = new Set<string>();
  for (const v of field.versions) {
    if (v.provisional || !canUseVersion(v)) continue;
    const base = `${title} (from ${versionSourceLabel(v.source)})`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
    used.add(name);
    names[v.id] = name;
  }
  return names;
}

/** Appearance group: "Keep newest" is preselected. */
export function initialAppearanceSelections(item: AppearanceItem): Record<string, string> {
  return { ...item.newest };
}

export function appearanceRequest(item: AppearanceItem, selections: Readonly<Record<string, string>>): ResolveGroupRequest {
  const regs = Object.keys(item.newest);
  const isNewest = regs.every((reg) => selections[reg] === item.newest[reg]) && Object.keys(selections).length === regs.length;
  return { kind: "appearance", row: item.row, choices: isNewest ? "keep-newest" : { ...selections } };
}

function deviceOf(versions: readonly ConflictVersion[]): string {
  const v = versions[0];
  if (!v) return "another device";
  return v.source.kind === "device" ? deviceNameOr(v.source.deviceName) : versionSourceLabel(v.source);
}

function whenOf(versions: readonly ConflictVersion[]): string {
  const v = versions[0];
  return v && v.timeMs > 0 ? ` (${formatShortDate(v.timeMs)})` : "";
}

/** "Deleted on MacBook (Sep 24); edited on iPhone (Sep 24)." */
export function editDeleteText(item: EditDeleteItem): string {
  return `Deleted on ${deviceOf(item.deleted)}${whenOf(item.deleted)}; edited on ${deviceOf(item.edited)}${whenOf(item.edited)}.`;
}

/** "Folder 'Servers' was deleted on MacBook; 2 items in it were changed." */
export function folderDeleteText(item: FolderDeleteItem, folderName: string): string {
  const n = item.changedItems.length;
  const changed = n === 1 ? "1 item in it was changed" : `${n} items in it were changed`;
  return `Folder '${folderName}' was deleted on ${deviceOf(item.deleted)}; ${changed} on another device.`;
}

/** "Folders 'X' and 'Y' were moved into each other on different devices." */
export function cycleText(item: CycleItem, names: readonly string[]): string {
  const noun = item.tbl === 2 ? "Folders" : "Items";
  const quoted = names.map((n) => `'${n}'`);
  const list = quoted.length <= 2 ? quoted.join(" and ") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
  return `${noun} ${list} were moved into each other on different devices.`;
}
