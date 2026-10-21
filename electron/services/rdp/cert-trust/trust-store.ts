// "Always trust" answers, per host and port, in a JSON file in this device's data folder. Not synced.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TrustedCert {
  fingerprint: string;
  subject: string;
  issuer: string;
  validTo: string;
  trustedAt: string;
}

interface StoreFile {
  version: 1;
  hosts: Record<string, TrustedCert>;
}

const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** "host:port", lower case; IPv6 addresses in brackets. */
export function hostKey(host: string, port: number): string {
  const bare = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

function isTrustedCert(v: unknown): v is TrustedCert {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.fingerprint === 'string' && FINGERPRINT_RE.test(c.fingerprint) &&
    typeof c.subject === 'string' && typeof c.issuer === 'string' &&
    typeof c.validTo === 'string' && typeof c.trustedAt === 'string'
  );
}

/** Valid entries only; anything else in the file is dropped. */
export function parseTrustFile(text: string): Record<string, TrustedCert> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return {};
  const hosts = (parsed as Partial<StoreFile>).hosts;
  if (typeof hosts !== 'object' || hosts === null) return {};
  return Object.fromEntries(Object.entries(hosts).filter(([, v]) => isTrustedCert(v)));
}

export class CertTrustStore {
  /** filePath is resolved on use, so the store can be made before the data folder is known. */
  constructor(private readonly filePath: () => string) {}

  get(host: string, port: number): TrustedCert | null {
    return this.read()[hostKey(host, port)] ?? null;
  }

  remember(host: string, port: number, cert: TrustedCert): void {
    const hosts = { ...this.read(), [hostKey(host, port)]: cert };
    const file: StoreFile = { version: 1, hosts };
    const path = this.filePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  }

  private read(): Record<string, TrustedCert> {
    let text: string;
    try {
      text = readFileSync(this.filePath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[RDP] Could not read trusted certificates:', e);
      return {};
    }
    try {
      return parseTrustFile(text);
    } catch (e) {
      console.warn('[RDP] The trusted certificates file is not valid JSON; treating it as empty:', e);
      return {};
    }
  }
}
