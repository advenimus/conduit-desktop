/**
 * Personal-vault unlock and lock notices inside main, so the startup vault (docs/AUTO_UNLOCK.md
 * 4.3, 4.6, 4.8, 5.4) can follow them without the unlock and lock flows knowing about it.
 * A listener that throws is logged and never fails the unlock or lock.
 */

import type { UnlockSource } from '../services/vault-session/open-personal-vault.js';

/** 'window-close' is the close handler's lock (hide to tray); every other lock is 'other'. */
export type LockCause = 'window-close' | 'other';

export interface UnlockedEvent {
  readonly source: UnlockSource;
  readonly lineageId: string;
}

export interface LockedEvent {
  readonly cause: LockCause;
}

type Listener<E> = (event: E) => void;

const unlocked: Listener<UnlockedEvent>[] = [];
const lockedListeners: Listener<LockedEvent>[] = [];

function emit<E>(listeners: readonly Listener<E>[], event: E, what: string): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(`[vault] a ${what} listener failed`, { name: err instanceof Error ? err.name : 'Error' });
    }
  }
}

export function onPersonalUnlocked(listener: Listener<UnlockedEvent>): () => void {
  unlocked.push(listener);
  return () => {
    const i = unlocked.indexOf(listener);
    if (i >= 0) unlocked.splice(i, 1);
  };
}

export function onPersonalLocked(listener: Listener<LockedEvent>): () => void {
  lockedListeners.push(listener);
  return () => {
    const i = lockedListeners.indexOf(listener);
    if (i >= 0) lockedListeners.splice(i, 1);
  };
}

export function emitPersonalUnlocked(event: UnlockedEvent): void {
  emit(unlocked, event, 'unlock');
}

export function emitPersonalLocked(event: LockedEvent): void {
  emit(lockedListeners, event, 'lock');
}
