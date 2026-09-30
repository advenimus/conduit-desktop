import { useEntryStore } from "../../../stores/entryStore";
import { toast } from "../../common/Toast";

/** Copies the entry's resolved password (its own or its linked credential's), with the tab menu's toasts. */
export async function copyPassword(entryId: string): Promise<void> {
  let password: string | null | undefined;
  try {
    password = (await useEntryStore.getState().resolveCredential(entryId))?.password;
  } catch (err) {
    console.warn("[home] resolve credential failed:", err);
    password = null;
  }
  if (!password) {
    toast.error("No password available");
    return;
  }
  try {
    await navigator.clipboard.writeText(password);
    toast.success("Password copied");
  } catch (err) {
    console.warn("[home] clipboard write failed:", err);
    toast.error("Couldn't copy the password");
  }
}
