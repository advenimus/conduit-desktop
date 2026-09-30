// Every user-facing string of docs/AUTO_UNLOCK.md 2 that more than one component shows.
import { toast } from "../components/common/Toast";

const VAULT_EXTENSION = /\.conduit$/i;

export function vaultFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

export function vaultName(filePath: string): string {
  return vaultFileName(filePath).replace(VAULT_EXTENSION, "");
}

export function isMacPlatform(platform: string | null | undefined): boolean {
  return platform === "darwin" || (platform == null && typeof navigator !== "undefined" && navigator.userAgent.includes("Mac"));
}

/** "Shift" everywhere, "Shift or Option" on a Mac. */
export function skipKeys(platform: string | null | undefined): string {
  return isMacPlatform(platform) ? "Shift or Option" : "Shift";
}

export const AUTO_UNLOCK_WARNING =
  "Anyone who can use this computer while you are logged in to it can open this vault and see its passwords. AI agents and other programs on this computer can use it once you click or type in Conduit. Only turn this on for a computer that only you use and that locks with a password.";

export const AUTO_UNLOCK_SHORT_WARNING =
  "Anyone who can use this computer while you are logged in can open this vault. Locking still asks for the password, but closing or quitting Conduit and opening it again does not.";

/** Mirrors PROOF_EXPIRED_MESSAGE in electron/ipc/auto-unlock-enable.ts. */
export const PROOF_EXPIRED_MESSAGE = "Unlock the vault again to turn this on.";

export const INDICATOR_TEXT = "Unlocks automatically on this computer";

export function toastAutoUnlockOn(name: string, platform: string | null | undefined): void {
  toast.success("Automatic unlock is on", `${name} opens when Conduit starts. Hold ${skipKeys(platform)} while Conduit starts to skip it.`);
}

export function toastAutoUnlockOff(name: string): void {
  toast.info("Automatic unlock is off", `${name} asks for the master password again.`);
}

export function toastStartupSet(name: string): void {
  toast.success(`${name} opens at startup`);
}

export function toastStartupCleared(name: string, forgot: boolean): void {
  toast.info(`${name} won't open at startup`, forgot ? "Automatic unlock is off too." : undefined);
}

export function toastSkipped(name: string | null): void {
  toast.info("Startup vault skipped", name ? `Conduit opened the Vault Hub. ${name} opens next time.` : "Conduit opened the Vault Hub.");
}

export function toastResealed(): void {
  toast.success("Saved unlock updated");
}

export function toastResealFailed(): void {
  toast.warning("Couldn't update the saved unlock", "Conduit will ask for the password at the next start.");
}

export function toastAccountChanged(): void {
  toast.info("Automatic unlock is off", "Another account signed in, so it was turned off on this computer.");
}
