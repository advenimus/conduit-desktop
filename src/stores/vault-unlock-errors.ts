import { parseOpenErrorMessage, type OpenErrorPayload } from "../types/sync";
import { errorText } from "../lib/errorText";

/** Options the personal unlock channels accept. */
export interface UnlockOptions {
  readonly previousPassword?: string;
  readonly takeover?: boolean;
  readonly recoverWorkingCopy?: boolean;
}

export interface ClassifiedUnlockError {
  /** Structured error: a sync dialog handles it. */
  readonly payload: OpenErrorPayload | null;
  /** Plain text for the dialog's error line (null when a sync dialog takes over). */
  readonly message: string | null;
}

const MAX_SHOWN_MESSAGE_LENGTH = 160;

/** Plain main-process messages worth showing as they are. */
const KNOWN_MESSAGES: Readonly<Record<string, string>> = {
  "Invalid master password": "Invalid master password",
  "Vault file not found": "Vault file not found. It may have been moved or renamed.",
  "Vault file already exists": "A vault file already exists at that location.",
  "Lock the open vault before unlocking another one.": "Lock the open vault before unlocking another one.",
  "Lock the open vault before switching": "Lock the open vault before switching.",
};

function rawMessage(err: unknown): string {
  return errorText(err, "");
}

function presentable(message: string): boolean {
  return message.length > 0 && message.length <= MAX_SHOWN_MESSAGE_LENGTH && !message.includes("\n");
}

/**
 * Sorts an unlock failure into a structured sync error or a line of text. Unknown messages are
 * shown when short and single-line, else `fallback`; the detail goes to the console.
 */
export function classifyUnlockError(err: unknown, fallback: string): ClassifiedUnlockError {
  const message = rawMessage(err);
  const payload = parseOpenErrorMessage(message);
  if (payload !== null) return { payload, message: null };
  const known = KNOWN_MESSAGES[message];
  if (known) return { payload: null, message: known };
  console.error("[vault] Unlock failed:", err);
  return { payload: null, message: presentable(message) ? message : fallback };
}

/** IPC args for vault_unlock / biometric_unlock with only the options that are set. */
export function unlockArgs(base: Record<string, unknown>, opts: UnlockOptions | undefined): Record<string, unknown> {
  if (!opts) return base;
  const out: Record<string, unknown> = { ...base };
  if (opts.previousPassword) out.previousPassword = opts.previousPassword;
  if (opts.takeover) out.takeover = true;
  if (opts.recoverWorkingCopy) out.recoverWorkingCopy = true;
  return out;
}
