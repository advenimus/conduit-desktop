// What the certificate prompt shows, read from the public certificate the helper sends.

import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';

export interface CertDetails {
  subject: string;
  issuer: string;
  /** ISO dates. */
  validFrom: string;
  validTo: string;
  /** SHA-256, upper-case hex pairs joined by colons. */
  fingerprint: string;
  expired: boolean;
  notYetValid: boolean;
  /** The certificate names this host (DNS name or IP address). */
  nameMatches: boolean;
  /** Signed by its own key, so it can only be trusted as a root. */
  selfSigned: boolean;
}

function oneLine(dn: string): string {
  return dn
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

function isoDate(text: string): string {
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}

function namesHost(cert: X509Certificate, host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return isIP(bare) ? cert.checkIP(bare) !== undefined : cert.checkHost(bare) !== undefined;
}

/** null when the PEM is not a certificate. */
export function describeCertificate(pem: string, host: string, now: Date = new Date()): CertDetails | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return null;
  }
  const validFrom = isoDate(cert.validFrom);
  const validTo = isoDate(cert.validTo);
  return {
    subject: oneLine(cert.subject),
    issuer: oneLine(cert.issuer),
    validFrom,
    validTo,
    fingerprint: cert.fingerprint256,
    expired: new Date(validTo).getTime() < now.getTime(),
    notYetValid: new Date(validFrom).getTime() > now.getTime(),
    nameMatches: namesHost(cert, host),
    selfSigned: cert.checkIssued(cert) && cert.verify(cert.publicKey),
  };
}
