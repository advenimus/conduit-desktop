/**
 * "Restart Now" for a downloaded update. The personal vault is flushed and its lease released
 * first (bounded by the quit flush cap): the Windows installer starts inside quitAndInstall and
 * force-closes the app about 2.5 s later, too soon for a flush started by before-quit.
 */

export interface UpdateInstallDeps {
  /** appQuitFlush().flushNow(): true when it closed the personal vault. Never throws. */
  flushVault(): Promise<boolean>;
  quitAndInstall(): void;
  /** The app.quit() safety net for when the tray keeps the process alive. */
  scheduleForceQuit(): void;
  onFailed(vaultFlushed: boolean, err: unknown): void;
}

export async function installAfterVaultFlush(deps: UpdateInstallDeps): Promise<void> {
  let vaultFlushed = false;
  try {
    vaultFlushed = await deps.flushVault();
    deps.quitAndInstall();
    deps.scheduleForceQuit();
  } catch (err) {
    deps.onFailed(vaultFlushed, err);
  }
}
