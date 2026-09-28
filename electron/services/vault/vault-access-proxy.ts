/**
 * The VaultAccessHost AppState hands the sync manager at construction. The handlers live in
 * the vault IPC module, which installs them when it registers (state.ts cannot import it
 * without a cycle).
 */

import type { LockedReason, VaultAccessHost } from '../vault-session/host.js';

export const ACCESS_NOT_READY_MESSAGE = 'Vault access handlers are not ready';

export class VaultAccessProxy implements VaultAccessHost {
  private target: VaultAccessHost | null = null;

  set(handlers: VaultAccessHost): void {
    this.target = handlers;
  }

  blockAccess(reason: LockedReason): void {
    this.require().blockAccess(reason);
  }

  softLock(reason: LockedReason): void {
    this.require().softLock(reason);
  }

  openPrivateInPlace(path: string, password: string): Promise<void> {
    return this.require().openPrivateInPlace(path, password);
  }

  createPrivateInPlace(path: string, password: string): Promise<void> {
    return this.require().createPrivateInPlace(path, password);
  }

  private require(): VaultAccessHost {
    if (this.target === null) throw new Error(ACCESS_NOT_READY_MESSAGE);
    return this.target;
  }
}
