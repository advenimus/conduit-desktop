import { invoke } from "../../lib/electron";
import { generateTotpCode } from "../../lib/totp";
import type { EntryFull } from "../../types/entry";

export interface ChipRef {
  kind: "secret" | "cred";
  id: string;
  field: "username" | "password" | "totp" | null;
  pending: boolean;
}

/** The value behind a chip, read from the unlocked vault in the main process. */
export async function readChipValue(ref: ChipRef, hiddenEntries: ReadonlyArray<{ id: string; config: unknown }>): Promise<string> {
  let id = ref.id;
  if (ref.pending) {
    const pending = hiddenEntries.find((e) => (e.config as { embedded?: { pending_for?: string } })?.embedded?.pending_for === ref.id);
    if (!pending) throw new Error("This secret has no staged new value");
    id = pending.id;
  }
  const entry = await invoke<EntryFull>("entry_get_full", { id });
  const field = ref.field ?? "password";
  if (field === "username") return entry.username ?? "";
  if (field === "totp") {
    if (!entry.totp_secret) throw new Error("No one-time password is set up");
    const cfg = entry.config as { totp_algorithm?: string; totp_digits?: number; totp_period?: number };
    return generateTotpCode({ secret: entry.totp_secret, algorithm: cfg.totp_algorithm, digits: cfg.totp_digits, period: cfg.totp_period }).code;
  }
  return entry.password ?? "";
}
