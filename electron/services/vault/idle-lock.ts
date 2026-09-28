/**
 * Optional idle auto-lock of the personal vault (off by default; settings
 * `vault_idle_lock_minutes`). Every IDLE_CHECK_MS the system idle time is compared with the
 * setting; the OS screen lock also locks while the setting is on. Locking is the same manual
 * lock the tray hide path runs. Electron specifics come in through IdleLockDeps.
 */

export const IDLE_CHECK_MS = 30_000;
const SECONDS_PER_MINUTE = 60;
const LOG = '[vault]';

export type IdleLockTrigger = 'idle' | 'lock-screen';

export interface IdleLockDeps {
  /** The setting in minutes; 0 means off. */
  minutes(): number;
  /** Seconds since the last user input (powerMonitor.getSystemIdleTime). */
  idleSeconds(): number;
  /** A personal vault is unlocked and no team vault is active. */
  canLock(): boolean;
  /** Lock the vault and tell the renderer. */
  lock(): Promise<void>;
  /** Subscribe to the OS screen lock; returns the unsubscribe function. */
  onLockScreen(listener: () => void): () => void;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

/** Whether a check for `trigger` should lock now. Never throws. */
export function shouldIdleLock(deps: Pick<IdleLockDeps, 'minutes' | 'idleSeconds' | 'canLock'>, trigger: IdleLockTrigger): boolean {
  try {
    const minutes = deps.minutes();
    if (!(minutes > 0) || !deps.canLock()) return false;
    return trigger === 'lock-screen' || deps.idleSeconds() >= minutes * SECONDS_PER_MINUTE;
  } catch (err) {
    console.warn(`${LOG} idle lock check failed`, { name: errName(err) });
    return false;
  }
}

/** Starts the checks; returns a stop function (before-quit). */
export function startIdleLock(deps: IdleLockDeps): () => void {
  let locking = false;
  const check = async (trigger: IdleLockTrigger): Promise<void> => {
    if (locking || !shouldIdleLock(deps, trigger)) return;
    locking = true;
    try {
      await deps.lock();
      console.info(`${LOG} vault locked automatically`, { trigger });
    } catch (err) {
      console.error(`${LOG} automatic lock failed`, { trigger, name: errName(err) });
    } finally {
      locking = false;
    }
  };
  const timer = setInterval(() => void check('idle'), IDLE_CHECK_MS);
  timer.unref?.();
  const unsubscribe = deps.onLockScreen(() => void check('lock-screen'));
  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
