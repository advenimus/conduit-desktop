/**
 * The pure parts of the startup vault (docs/AUTO_UNLOCK.md 3.5, 4.2, 4.3, 4.6): the setting and its
 * validation, the one-shot startup attempt with its retries and re-arm rule, and the plan a start
 * follows. Electron and the file system stay in startup-vault.ts.
 */

import path from 'node:path';

export type StartupVault =
  | { readonly kind: 'hub' }
  | { readonly kind: 'personal'; readonly path: string; readonly lineageId: string | null }
  | { readonly kind: 'team'; readonly teamVaultId: string };

export type StartupPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'hub'; readonly skipped?: { readonly name: string | null }; readonly missing?: { readonly fileName: string; readonly path: string } }
  | { readonly kind: 'automatic' }
  | { readonly kind: 'team'; readonly teamVaultId: string }
  | { readonly kind: 'personal'; readonly path: string; readonly name: string; readonly auto: boolean };

export const ATTEMPT_LIFETIME_MS = 10 * 60_000;
const VAULT_EXTENSION = /\.conduit$/i;

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** settings.startup_vault as stored; anything malformed reads as null (today's rule) with a warning. */
export function parseStartupVault(raw: unknown): StartupVault | null {
  if (raw === null || raw === undefined) return null;
  const r = typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (r?.kind === 'hub') return { kind: 'hub' };
  if (r?.kind === 'personal' && nonEmpty(r.path) && path.isAbsolute(r.path) && !r.path.includes('\0')) {
    return { kind: 'personal', path: r.path, lineageId: nonEmpty(r.lineageId) ? r.lineageId : null };
  }
  if (r?.kind === 'team' && nonEmpty(r.teamVaultId)) return { kind: 'team', teamVaultId: r.teamVaultId };
  console.warn('[startup-vault] ignoring an invalid startup_vault setting');
  return null;
}

/** The display name of a vault file: its base name without ".conduit". */
export function vaultDisplayName(filePath: string): string {
  return path.basename(filePath).replace(VAULT_EXTENSION, '');
}

type StartupField = { readonly startup_vault?: StartupVault | null };

/** The file at `from` is now at `to` (rename, or a move sync followed): a personal startup vault follows it. */
export function withStartupPathMoved<S extends StartupField>(settings: S, from: string, to: string): S {
  const sv = settings.startup_vault;
  if (sv?.kind !== 'personal' || sv.path !== from) return settings;
  return { ...settings, startup_vault: { ...sv, path: to } };
}

/** `vaultPath` left the recent list: a personal startup vault at that path becomes the Vault Hub. */
export function withStartupCleared<S extends StartupField>(settings: S, vaultPath: string | null): S {
  const sv = settings.startup_vault;
  if (sv?.kind !== 'personal' || (vaultPath !== null && sv.path !== vaultPath)) return settings;
  return { ...settings, startup_vault: { kind: 'hub' } };
}

export interface PlanInput {
  readonly skipRequested: boolean;
  readonly startupVault: StartupVault | null;
  readonly lastVaultType: string | null;
  readonly fileExists: boolean;
  /** lineageForPath(path) equals the stored lineage; false when either is unknown. */
  readonly lineageMatches: boolean;
  readonly launchHasUrl: boolean;
  readonly entryExists: boolean;
  readonly storeUsable: boolean;
}

/** Steps b to f of spec 4.2 (the one-shot, step a, is the attempt's). */
export function decidePlan(input: PlanInput): StartupPlan {
  const sv = input.startupVault;
  if (input.skipRequested) {
    if (sv?.kind === 'personal') return { kind: 'hub', skipped: { name: vaultDisplayName(sv.path) } };
    if (sv?.kind === 'team' || (sv === null && input.lastVaultType === 'team')) return { kind: 'hub', skipped: { name: null } };
    return { kind: 'hub' };
  }
  if (sv === null) return { kind: 'automatic' };
  if (sv.kind === 'hub') return { kind: 'hub' };
  if (sv.kind === 'team') return { kind: 'team', teamVaultId: sv.teamVaultId };
  const name = vaultDisplayName(sv.path);
  if (!input.fileExists) return { kind: 'hub', missing: { fileName: path.basename(sv.path), path: sv.path } };
  const auto = input.lineageMatches && !input.launchHasUrl && input.entryExists && input.storeUsable;
  return { kind: 'personal', path: sv.path, name, auto };
}

type Phase = 'armed' | 'used' | 'open' | 'done';

/**
 * The startup attempt (spec 4.3): armed at process start and on a qualifying re-show, used by the
 * plan, open while a failed automatic open may be retried by a click, done otherwise. It holds the
 * saved password between the first read and done, for retries and the previous-password fill.
 */
export class StartupAttempt {
  private phase: Phase = 'armed';
  private openedAt = 0;
  private saved: string | null = null;
  private autoOpened = false;
  private rearmOnShow = false;

  constructor(private readonly now: () => number) {}

  /** Step a: true once per armed start. */
  consume(): boolean {
    if (this.phase !== 'armed') return false;
    this.phase = 'used';
    this.openedAt = this.now();
    return true;
  }

  /** 'first' right after the plan, 'retry' while open, null when no automatic attempt may run. */
  attemptKind(): 'first' | 'retry' | null {
    if (this.phase !== 'done' && this.now() - this.openedAt > ATTEMPT_LIFETIME_MS) this.finish();
    if (this.phase === 'used') return 'first';
    if (this.phase === 'open') return 'retry';
    return null;
  }

  isOpen(): boolean {
    return this.attemptKind() === 'retry';
  }

  holdPassword(password: string): void {
    this.saved = password;
  }

  savedPassword(): string | null {
    return this.phase === 'done' ? null : this.saved;
  }

  /** The automatic open did not succeed; clicks in the fallback dialogs may retry. */
  markFailed(): void {
    if (this.phase === 'used' || this.phase === 'open') this.phase = 'open';
  }

  finish(): void {
    this.phase = 'done';
    this.saved = null;
  }

  succeeded(): void {
    this.finish();
    this.autoOpened = true;
  }

  wasAutoOpened(): boolean {
    return this.autoOpened;
  }

  /** Any unlock by a person, or opening another vault. */
  userUnlocked(): void {
    this.finish();
    this.autoOpened = false;
  }

  /**
   * A lock closed the vault. Only the close handler's lock of a vault that opened automatically
   * and was not locked since re-arms (on the next show); every other lock keeps its meaning.
   */
  locked(byWindowClose: boolean, closedSomething: boolean): void {
    if (byWindowClose && closedSomething && this.autoOpened) this.rearmOnShow = true;
    this.autoOpened = false;
    this.finish();
  }

  /** A second launch with a link or a file argument: the next show must not re-arm. */
  cancelRearm(): void {
    this.rearmOnShow = false;
  }

  /** The window shows again: re-arms once after a qualifying close. */
  shown(): boolean {
    if (!this.rearmOnShow) return false;
    this.rearmOnShow = false;
    this.phase = 'armed';
    this.saved = null;
    return true;
  }
}
