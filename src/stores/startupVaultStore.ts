import { create } from "zustand";
import { invoke } from "../lib/electron";
import { useSyncStore } from "./syncStore";
import { useVaultStore } from "./vaultStore";
import { classifyUnlockError, type UnlockOptions } from "./vault-unlock-errors";
import { unlockSucceeded } from "./vault-sync-hooks";

/** docs/AUTO_UNLOCK.md 3.5 (mirrors electron/ipc/startup-vault-core.ts). */
export type StartupVault =
  | { readonly kind: "hub" }
  | { readonly kind: "personal"; readonly path: string; readonly lineageId: string | null }
  | { readonly kind: "team"; readonly teamVaultId: string };

export interface StartupStatus {
  readonly platform: string;
  readonly store: { readonly usable: boolean; readonly reason: "ok" | "unavailable" | "weak" | string; readonly storeName: string };
  readonly startupVault: StartupVault | null;
  /** The vault with a saved unlock (always the startup vault), else null. */
  readonly savedPath: string | null;
  /** The open personal vault is the one with the saved unlock. */
  readonly currentOn: boolean;
}

export type StartupChoice =
  | { readonly kind: "automatic" }
  | { readonly kind: "hub" }
  | { readonly kind: "personal"; readonly path: string }
  | { readonly kind: "team"; readonly teamVaultId: string };

export type EnableProof = { readonly kind: "recent-unlock" } | { readonly kind: "password"; readonly password: string } | { readonly kind: "biometric" };

export type AutoUnlockFallback = "stale" | "unreadable" | "account" | "not-allowed" | "missing-file";

/** Why the unlock dialog is showing for the startup vault after an automatic attempt. */
export interface StartupFallback {
  readonly kind: "stale" | "unreadable" | "saved";
  readonly name: string;
}

export interface StartupOpening {
  readonly text: string;
  readonly cancellable: boolean;
}

export type AutoUnlockOutcome = { readonly ok: true } | { readonly ok: false; readonly fallback: AutoUnlockFallback };

/** A confirm the Hub or vault menu asks for before a change that forgets a saved unlock (spec 2.4, 2.6). */
export interface StartupConfirm {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  run(): Promise<void>;
}

export interface AutoUnlockRequest extends UnlockOptions {
  /** A password typed in a fallback dialog. */
  readonly password?: string;
}

interface StartupVaultState {
  /** True until the startup routine has decided what to show. */
  pending: boolean;
  opening: StartupOpening | null;
  status: StartupStatus | null;
  fallback: StartupFallback | null;
  confirm: StartupConfirm | null;
  askConfirm: (confirm: StartupConfirm | null) => void;
  setPending: (pending: boolean) => void;
  setOpening: (opening: StartupOpening | null) => void;
  setFallback: (fallback: StartupFallback | null) => void;
  refresh: () => Promise<StartupStatus | null>;
  setStartup: (choice: StartupChoice) => Promise<{ status: StartupStatus; forgot: boolean }>;
  enable: (proof: EnableProof) => Promise<StartupStatus>;
  disable: () => Promise<StartupStatus>;
  /** vault_auto_unlock from a fallback dialog; errors land where biometricUnlock puts them. */
  autoUnlock: (req?: AutoUnlockRequest) => Promise<AutoUnlockOutcome>;
}

function isStatus(v: unknown): v is StartupStatus {
  if (typeof v !== "object" || v === null) return false;
  const store = (v as { store?: unknown }).store;
  return typeof store === "object" && store !== null && typeof (store as { usable?: unknown }).usable === "boolean";
}

function autoUnlockArgs(req: AutoUnlockRequest | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (req?.password) out.password = req.password;
  if (req?.previousPassword) out.previousPassword = req.previousPassword;
  if (req?.takeover) out.takeover = true;
  if (req?.recoverWorkingCopy) out.recoverWorkingCopy = true;
  return out;
}

export const useStartupVaultStore = create<StartupVaultState>((set, get) => ({
  pending: true,
  opening: null,
  status: null,
  fallback: null,
  confirm: null,

  askConfirm: (confirm) => set({ confirm }),
  setPending: (pending) => set({ pending }),
  setOpening: (opening) => set({ opening }),
  setFallback: (fallback) => set({ fallback }),

  refresh: async () => {
    try {
      const raw = await invoke<unknown>("auto_unlock_status");
      const status = isStatus(raw) ? raw : null;
      set({ status });
      return status;
    } catch (err) {
      console.warn("[startup-vault] could not read the startup vault status", err);
      return null;
    }
  },

  setStartup: async (choice) => {
    const res = await invoke<{ status: StartupStatus; forgot: boolean }>("startup_vault_set", { ...choice });
    set({ status: res.status });
    return res;
  },

  enable: async (proof) => {
    const status = await invoke<StartupStatus>("auto_unlock_enable", { proof });
    set({ status, fallback: null });
    return status;
  },

  disable: async () => {
    const status = await invoke<StartupStatus>("auto_unlock_disable");
    set({ status });
    return status;
  },

  autoUnlock: async (req) => {
    const vault = useVaultStore.getState();
    useVaultStore.setState({ isLoading: true, error: null });
    try {
      const res = await invoke<AutoUnlockOutcome>("vault_auto_unlock", autoUnlockArgs(req));
      if (res.ok) {
        unlockSucceeded((partial) => useVaultStore.setState(partial));
        useVaultStore.setState({ isUnlocked: true, isLoading: false });
        await vault.loadCredentials();
        void get().refresh();
      } else {
        useVaultStore.setState({ isLoading: false });
      }
      return res;
    } catch (err) {
      const { payload, message } = classifyUnlockError(err, "Invalid master password");
      const sync = useSyncStore.getState();
      sync.setOpenWaiting(null);
      sync.setOpenError(payload);
      useVaultStore.setState({ isLoading: false, error: message });
      throw err;
    }
  },
}));
