/**
 * Pending requests from agents to see a secret's plain value. Each one waits for the user to click
 * Allow or Deny in the reveal dialog; no answer within the timeout counts as Deny.
 */

import { randomUUID } from 'node:crypto';

export const REVEAL_TIMEOUT_MS = 60_000;

export interface RevealRequestInfo {
  request_id: string;
  agent_name: string | null;
  kind: 'credential' | 'secret';
  target_id: string;
  target_name: string;
  /** The asset an embedded secret belongs to. */
  owner_name: string | null;
  purpose: string;
}

export interface RevealNotifier {
  requested(info: RevealRequestInfo): void;
  resolved(requestId: string, approved: boolean): void;
}

interface Pending {
  info: RevealRequestInfo;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private notifier: RevealNotifier | null = null;

  setNotifier(notifier: RevealNotifier | null): void {
    this.notifier = notifier;
  }

  /** Resolves false at once when no window can show the dialog. */
  request(info: Omit<RevealRequestInfo, 'request_id'>, timeoutMs = REVEAL_TIMEOUT_MS): Promise<boolean> {
    if (!this.notifier) return Promise.resolve(false);
    const notifier = this.notifier;
    const full: RevealRequestInfo = { ...info, request_id: randomUUID() };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.resolve(full.request_id, false), timeoutMs);
      this.pending.set(full.request_id, { info: full, resolve, timer });
      notifier.requested(full);
    });
  }

  resolve(requestId: string, approved: boolean): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(approved);
    this.notifier?.resolved(requestId, approved);
    return true;
  }

  getPendingInfo(requestId: string): RevealRequestInfo | null {
    return this.pending.get(requestId)?.info ?? null;
  }

  listPending(): RevealRequestInfo[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  /** Denies everything still waiting, for example when the vault locks. */
  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.resolve(id, false);
  }
}
