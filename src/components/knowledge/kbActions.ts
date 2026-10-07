import { invoke } from "../../lib/electron";
import { errorText } from "../../lib/errorText";
import { useEntryStore } from "../../stores/entryStore";
import { toast } from "../common/Toast";

/** Runs a knowledge IPC call, reloads the entry store, and reports failure as a toast. */
export async function kbCall<T>(command: string, args: Record<string, unknown>, failure: string): Promise<T | null> {
  try {
    const result = await invoke<T>(command, args);
    await useEntryStore.getState().loadAll();
    return result;
  } catch (err) {
    toast.error(errorText(err, failure));
    return null;
  }
}
