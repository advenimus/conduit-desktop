/**
 * The editor saves only the fields the user changed. An omitted field keeps the vault's current
 * value, so a conflict resolved in the review panel while the editor is open is not written
 * back to the value the editor loaded (spec 7.2).
 */

export type EditorFields = Readonly<Record<string, unknown>>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Fields of `current` that differ from what the editor loaded; everything when nothing was loaded. */
export function changedEditorFields<T extends EditorFields>(loaded: T | null, current: T): Partial<T> {
  if (loaded === null) return current;
  const changed = Object.entries(current).filter(([key, value]) => !sameValue(loaded[key], value));
  return Object.fromEntries(changed) as Partial<T>;
}
