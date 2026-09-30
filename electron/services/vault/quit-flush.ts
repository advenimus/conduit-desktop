/**
 * before-quit with a personal vault open (spec 6.4): the quit waits for one bounded flush (final
 * sync cycle, lease release) and then quits again. The sync manager caps its own quit; the cap
 * here is a second guard so a stuck flush can never keep the app from quitting. The update
 * installer runs the same flush first (flushNow), because it does not wait for before-quit.
 */

/** Extra time over the sync manager's own cap before the app quits regardless. */
export const QUIT_FLUSH_MARGIN_MS = 1000;
const LOG = '[vault-session]';

export interface QuitFlushDeps {
  /** A personal vault is open or soft-locked (its lease still needs releasing). */
  needsFlush(): boolean;
  flush(): Promise<void>;
  /** app.quit(): runs before-quit again, which now passes. */
  quit(): void;
  readonly capMs: number;
}

export interface QuitEvent {
  preventDefault(): void;
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'Error';
}

async function boundedFlush(deps: QuitFlushDeps): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<'cap'>((resolve) => {
    timer = setTimeout(() => resolve('cap'), deps.capMs);
  });
  try {
    const res = await Promise.race([deps.flush().then(() => 'done' as const), cap]);
    if (res === 'cap') console.warn(`${LOG} quit flush hit its cap; quitting anyway`);
  } catch (err) {
    console.error(`${LOG} quit flush failed; quitting anyway`, { name: errName(err) });
  } finally {
    clearTimeout(timer);
  }
}

export interface QuitFlush {
  /**
   * The before-quit hook: true when it deferred this quit (the caller returns and skips its
   * cleanup, which runs on the next before-quit, after the flush).
   */
  beforeQuit(event: QuitEvent): boolean;
  /**
   * Runs the same bounded flush now, without quitting: for exits that do not wait for
   * before-quit (the Windows update installer force-closes the app about 2.5 s after it starts).
   * A quit during it waits for it; later quits pass at once. Resolves true when a flush ran
   * (the personal vault is closed now). Never throws.
   */
  flushNow(): Promise<boolean>;
  /**
   * The exit after flushNow did not happen (the update install failed): later quits flush
   * again, since the user may unlock the vault before quitting.
   */
  reset(): void;
}

export function createQuitFlush(deps: QuitFlushDeps): QuitFlush {
  let flushing: Promise<void> | null = null;
  let done = false;
  let quitAfterFlush = false;
  const needsFlush = (): boolean => {
    try {
      return deps.needsFlush();
    } catch (err) {
      console.warn(`${LOG} quit flush check failed`, { name: errName(err) });
      return false;
    }
  };
  const start = (): Promise<void> => {
    flushing ??= boundedFlush(deps).finally(() => {
      done = true;
      if (quitAfterFlush) deps.quit();
    });
    return flushing;
  };
  return {
    beforeQuit(event) {
      if (done) return false;
      if (flushing === null && !needsFlush()) return false;
      event.preventDefault();
      quitAfterFlush = true;
      void start();
      return true;
    },
    async flushNow() {
      if (done || (flushing === null && !needsFlush())) return false;
      await start();
      return true;
    },
    reset() {
      if (!done || quitAfterFlush) return;
      done = false;
      flushing = null;
    },
  };
}
