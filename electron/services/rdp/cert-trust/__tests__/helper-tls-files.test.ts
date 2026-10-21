// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEGACY_OPENSSL_CONF, buildCaBundle, prepareHelperTlsFiles } from '../helper-tls-files.js';

describe('buildCaBundle', () => {
  it('joins the lists and drops repeats', () => {
    const a = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----';
    const b = '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----';
    expect(buildCaBundle([[a, b], [`${a}\n`, '']])).toBe(`${a}\n${b}\n`);
    expect(buildCaBundle([[], []])).toBe('');
  });
});

describe('prepareHelperTlsFiles', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('points OpenSSL at the CA list, and at the old-server options only when asked', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-tls-'));
    const plain = prepareHelperTlsFiles(dir, false);
    expect(plain.configDir).toBe(path.join(dir, 'freerdp'));
    expect(plain.env.OPENSSL_CONF).toBeUndefined();
    expect(fs.readFileSync(plain.env.SSL_CERT_FILE!, 'utf8')).toContain('BEGIN CERTIFICATE');

    const legacy = prepareHelperTlsFiles(dir, true);
    expect(fs.readFileSync(legacy.env.OPENSSL_CONF!, 'utf8')).toBe(LEGACY_OPENSSL_CONF);
    expect(LEGACY_OPENSSL_CONF).toContain('UnsafeLegacyServerConnect');
  });
});

describe('isTrustedRoot', () => {
  it('knows a bundled CA and not a test certificate', async () => {
    const { getCACertificates } = await import('node:tls');
    const { X509Certificate } = await import('node:crypto');
    const { isTrustedRoot } = await import('../helper-tls-files.js');
    const someCa = new X509Certificate(getCACertificates('bundled')[0]).fingerprint256;
    expect(isTrustedRoot(someCa)).toBe(true);
    expect(isTrustedRoot('C2:6A:53:AB:64:44:C4:C9:12:9A:27:AC:E0:ED:79:0B:44:46:D9:63:69:D0:6F:49:76:A0:BE:E0:4C:B0:44:EB')).toBe(false);
  });
});
