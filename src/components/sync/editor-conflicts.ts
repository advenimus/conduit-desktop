import { syncApi } from "../../lib/sync-api";
import { useSyncStore } from "../../stores/syncStore";
import { groupsForRow } from "../../stores/sync-reducers";
import { toast } from "../common/Toast";
import type { ConflictGroup } from "../../types/sync";

function fieldLabels(groups: readonly ConflictGroup[], entryId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groupsForRow(groups, { tbl: 1, rowId: entryId })) {
    for (const item of g.items) {
      if (item.kind === "field") out.set(item.field.key.reg, item.field.label);
      if (item.kind === "appearance") item.fields.forEach((f) => out.set(f.key.reg, f.label));
    }
  }
  return out;
}

/** Conflicted fields of an entry before the editor saves (reg -> label). */
export function conflictFieldsBeforeSave(entryId: string): Map<string, string> {
  return fieldLabels(useSyncStore.getState().conflicts, entryId);
}

/**
 * After an editor save: a changed field is written as a new interactive value that replaces
 * the other versions (7.2 "saving from the editor resolves that field and says so").
 */
export async function announceResolvedBySave(entryId: string, before: Map<string, string>): Promise<void> {
  if (before.size === 0) return;
  try {
    const after = fieldLabels(await syncApi.listConflicts(), entryId);
    const resolved = [...before].filter(([reg]) => !after.has(reg)).map(([, label]) => label);
    if (resolved.length > 0) toast.success("Saved. Conflict resolved.", `Your values are now used for: ${resolved.join(", ")}.`);
    await useSyncStore.getState().refresh();
  } catch (err) {
    console.error("[sync] Failed to check conflicts after save:", err);
  }
}
