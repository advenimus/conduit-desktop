import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";
import type { EntryMeta } from "../../types/entry";

function isEntry(value: unknown): value is EntryMeta {
  return typeof value === "object" && value !== null && typeof (value as EntryMeta).id === "string" && typeof (value as EntryMeta).config === "object";
}

/**
 * Runs a knowledge IPC call and reports failure as a toast. A returned entry replaces the store's
 * copy at once, so controls such as the kind picker don't snap back while the full reload (which
 * also picks up new secrets) runs in the background.
 */
export async function kbCall<T>(command: string, args: Record<string, unknown>, failure: string): Promise<T | null> {
  try {
    const result = await invoke<T>(command, args);
    if (isEntry(result)) {
      useEntryStore.setState((s) => ({
        entries: s.entries.map((e) => (e.id === result.id ? result : e)),
        hiddenEntries: s.hiddenEntries.some((e) => e.id === result.id)
          ? s.hiddenEntries.map((e) => (e.id === result.id ? result : e))
          : [...s.hiddenEntries, result],
      }));
    }
    void useEntryStore.getState().loadAll();
    return result;
  } catch (err) {
    toast.error(errorText(err, failure));
    return null;
  }
}
