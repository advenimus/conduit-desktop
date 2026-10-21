// Files the helper's OpenSSL reads: the CAs this computer trusts, and the old-server options.

import { X509Certificate } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Lets OpenSSL connect to servers without secure renegotiation (RFC 5746). TLS 1.0/1.1 is the helper's TlsSecLevel. */
export const LEGACY_OPENSSL_CONF = `openssl_conf = conduit_conf

[conduit_conf]
ssl_conf = ssl_sect

[ssl_sect]
system_default = system_default_sect

[system_default_sect]
Options = UnsafeLegacyServerConnect
`;

export interface HelperTlsFiles {
  /** FreeRDP's config folder; its certificate store there is never written. */
  configDir: string;
  /** Environment for the helper process. */
  env: Record<string, string>;
}

/** Bundled CAs plus the system's (Keychain or Windows store, including company CAs), one copy of each. */
export function buildCaBundle(lists: readonly (readonly string[])[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pem of lists.flat()) {
    const key = pem.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

let caLists: string[][] | null = null;

// Reading the system store (Keychain or Windows store) is slow, so it is read once per run.
function readCaLists(): string[][] {
  if (caLists) return caLists;
  const lists: string[][] = [];
  for (const kind of ['bundled', 'system'] as const) {
    try {
      lists.push(getCACertificates(kind));
    } catch (e) {
      console.warn(`[RDP] Could not read the ${kind} CA certificates:`, e);
    }
  }
  caLists = lists;
  return lists;
}

let rootFingerprints: Set<string> | null = null;

/** Whether a certificate with this SHA-256 fingerprint is one of the CAs in the helper's list. */
export function isTrustedRoot(fingerprint: string): boolean {
  if (!rootFingerprints) {
    rootFingerprints = new Set();
    for (const pem of readCaLists().flat()) {
      try {
        rootFingerprints.add(new X509Certificate(pem).fingerprint256);
      } catch {
        // A CA Node cannot parse cannot match either.
      }
    }
  }
  return rootFingerprints.has(fingerprint);
}

let caBundlePath: string | null = null;

// A failed write is not remembered, so the next connect tries again.
function ensureCaBundle(dataDir: string): string | null {
  if (caBundlePath) return caBundlePath;
  const bundle = buildCaBundle(readCaLists());
  const path = join(dataDir, 'rdp-ca-bundle.pem');
  try {
    if (!bundle) throw new Error('no CA certificates found');
    writeFileSync(path, bundle, { mode: 0o644 });
    caBundlePath = path;
  } catch (e) {
    console.error('[RDP] Could not write the CA list; every RDP certificate will need the user to trust it:', e);
  }
  return caBundlePath;
}

/** Writes what the helper needs into dataDir. legacyTls when the gateway or the computer allows old TLS. */
export function prepareHelperTlsFiles(dataDir: string, legacyTls: boolean): HelperTlsFiles {
  const configDir = join(dataDir, 'freerdp');
  const env: Record<string, string> = {};
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    console.error('[RDP] Could not create the data folder for the RDP helper:', e);
  }

  const ca = ensureCaBundle(dataDir);
  if (ca) env.SSL_CERT_FILE = ca;

  if (legacyTls) {
    const conf = join(dataDir, 'rdp-openssl-legacy.cnf');
    try {
      writeFileSync(conf, LEGACY_OPENSSL_CONF, { mode: 0o644 });
      env.OPENSSL_CONF = conf;
    } catch (e) {
      console.error('[RDP] Could not write the old-TLS OpenSSL settings; servers without secure renegotiation will fail:', e);
    }
  }
  return { configDir, env };
}
