// Decides on a certificate the helper could not verify: a remembered match connects, anything else asks the user.

import { describeCertificate, type CertDetails } from './cert-details.js';
import type { CertPromptInfo, CertPromptOutcome, CertProblem } from './cert-prompts.js';
import type { TrustedCert } from './trust-store.js';

/** A CERT_VERIFY request from the helper. pem is the server's public certificate. */
export interface HelperCertRequest {
  id: number;
  host: string;
  port: number;
  hop: 'gateway' | 'target';
  /** FreeRDP found no DNS name for the host in the certificate (it does not check IP addresses). */
  mismatch: boolean;
  changed: boolean;
  pem: string;
}

export interface CertCheckContext {
  origin: 'user' | 'agent';
  connectionName?: string;
  signal?: AbortSignal;
}

export type CertVerdict = { accept: true } | { accept: false; message: string };

export interface CertStore {
  get(host: string, port: number): TrustedCert | null;
  remember(host: string, port: number, cert: TrustedCert): void;
}

export interface CertPrompts {
  request(info: Omit<CertPromptInfo, 'request_id'>, opts: { signal?: AbortSignal }): Promise<CertPromptOutcome>;
}

export const SKIP_CERT_HINT =
  "Open this connection once in Conduit and choose Always trust, or turn on Skip certificate verification in the entry's Security settings.";

function problemsOf(req: HelperCertRequest, details: CertDetails, isTrustedRoot: (fingerprint: string) => boolean): CertProblem[] {
  const problems: CertProblem[] = [];
  if (!details.nameMatches) problems.push('name');
  // FreeRDP asks about a matching name only when the chain failed; with a mismatch the chain result is unknown,
  // except for a self-signed certificate, which is trusted only when it is itself a trusted root.
  const untrusted = !req.mismatch || (details.selfSigned && !isTrustedRoot(details.fingerprint));
  if (untrusted) problems.push('untrusted');
  else problems.push('unverified');
  if (details.expired) problems.push('expired');
  if (details.notYetValid) problems.push('not-yet-valid');
  return problems;
}

function placeOf(req: HelperCertRequest): string {
  const host = req.host.includes(':') ? `[${req.host}]` : req.host;
  return req.hop === 'gateway' ? `the gateway ${host}:${req.port}` : `${host}:${req.port}`;
}

function refusal(outcome: CertPromptOutcome, req: HelperCertRequest, ctx: CertCheckContext): string {
  const place = placeOf(req);
  if (outcome === 'aborted') return 'The connection was closed while the certificate question was open.';
  if (ctx.origin === 'agent') {
    return outcome === 'cancel'
      ? `The certificate of ${place} was not trusted in the Conduit app.`
      : `The certificate of ${place} is not trusted yet, and no one answered in the Conduit app. ${SKIP_CERT_HINT}`;
  }
  if (outcome === 'cancel') return `You did not trust the certificate of ${place}.`;
  if (outcome === 'timeout') return `No one answered the certificate question for ${place} within a minute. Connect again to see it.`;
  return `Conduit could not show the certificate question for ${place}. Connect again from the app window.`;
}

export class RdpCertTrust {
  constructor(
    private readonly store: CertStore,
    private readonly prompts: CertPrompts,
    private readonly now: () => Date = () => new Date(),
    private readonly isTrustedRoot: (fingerprint: string) => boolean = () => false,
  ) {}

  async check(req: HelperCertRequest, ctx: CertCheckContext): Promise<CertVerdict> {
    const details = describeCertificate(req.pem, req.host, this.now());
    if (!details) {
      return { accept: false, message: `The certificate of ${placeOf(req)} could not be read, so Conduit did not connect.` };
    }

    const stored = this.store.get(req.host, req.port);
    if (stored?.fingerprint === details.fingerprint) return { accept: true };

    const outcome = await this.prompts.request(
      {
        origin: ctx.origin,
        kind: stored ? 'changed' : 'new',
        hop: req.hop,
        host: req.host,
        port: req.port,
        connection_name: ctx.connectionName ?? null,
        problems: problemsOf(req, details, this.isTrustedRoot),
        subject: details.subject,
        issuer: details.issuer,
        valid_from: details.validFrom,
        valid_to: details.validTo,
        fingerprint: details.fingerprint,
        previous: stored
          ? {
              fingerprint: stored.fingerprint,
              subject: stored.subject,
              issuer: stored.issuer,
              valid_to: stored.validTo,
              trusted_at: stored.trustedAt,
            }
          : null,
      },
      { signal: ctx.signal },
    );

    if (outcome === 'once') return { accept: true };
    if (outcome === 'always') {
      try {
        this.store.remember(req.host, req.port, {
          fingerprint: details.fingerprint,
          subject: details.subject,
          issuer: details.issuer,
          validTo: details.validTo,
          trustedAt: this.now().toISOString(),
        });
      } catch (e) {
        console.error('[RDP] Could not save the trusted certificate; it is trusted for this connection only:', e);
      }
      return { accept: true };
    }
    return { accept: false, message: refusal(outcome, req, ctx) };
  }
}
