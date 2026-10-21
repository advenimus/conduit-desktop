// Pending certificate questions. Each waits for Trust once, Always trust or Cancel in the app's dialog;
// no answer within the timeout counts as Cancel, like the reveal dialog (reveal-approvals.ts).

import { randomUUID } from 'node:crypto';

export const CERT_PROMPT_TIMEOUT_MS = 60_000;

export type CertAnswer = 'once' | 'always' | 'cancel';
export type CertPromptOutcome = CertAnswer | 'timeout' | 'no-window' | 'aborted';

export type CertProblem = 'untrusted' | 'name' | 'unverified' | 'expired' | 'not-yet-valid';

export interface PreviousCert {
  fingerprint: string;
  subject: string;
  issuer: string;
  valid_to: string;
  trusted_at: string;
}

export interface CertPromptInfo {
  request_id: string;
  /** 'agent' when an MCP client opened the connection. */
  origin: 'user' | 'agent';
  kind: 'new' | 'changed';
  hop: 'gateway' | 'target';
  host: string;
  port: number;
  connection_name: string | null;
  problems: CertProblem[];
  subject: string;
  issuer: string;
  valid_from: string;
  valid_to: string;
  fingerprint: string;
  previous: PreviousCert | null;
}

export interface CertPromptNotifier {
  /** False when no window can show the dialog. */
  requested(info: CertPromptInfo): boolean;
  resolved(requestId: string, outcome: CertPromptOutcome): void;
}

interface Pending {
  info: CertPromptInfo;
  finish: (outcome: CertPromptOutcome) => void;
}

export class CertPromptManager {
  private pending = new Map<string, Pending>();
  private notifier: CertPromptNotifier | null = null;

  setNotifier(notifier: CertPromptNotifier | null): void {
    this.notifier = notifier;
  }

  request(
    info: Omit<CertPromptInfo, 'request_id'>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CertPromptOutcome> {
    if (opts.signal?.aborted) return Promise.resolve('aborted');
    const notifier = this.notifier;
    if (!notifier) return Promise.resolve('no-window');
    const full: CertPromptInfo = { ...info, request_id: randomUUID() };

    return new Promise<CertPromptOutcome>((resolve) => {
      const onAbort = () => this.settle(full.request_id, 'aborted');
      const timer = setTimeout(() => this.settle(full.request_id, 'timeout'), opts.timeoutMs ?? CERT_PROMPT_TIMEOUT_MS);
      this.pending.set(full.request_id, {
        info: full,
        finish: (outcome) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      });
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      if (!notifier.requested(full)) this.settle(full.request_id, 'no-window');
    });
  }

  /** The user's answer from the dialog. False when the question already ended. */
  answer(requestId: string, answer: CertAnswer): boolean {
    return this.settle(requestId, answer);
  }

  listPending(): CertPromptInfo[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  private settle(requestId: string, outcome: CertPromptOutcome): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.finish(outcome);
    this.notifier?.resolved(requestId, outcome);
    return true;
  }
}
