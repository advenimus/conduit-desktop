import { describe, it, expect } from 'vitest';
import type { RdpEngineConfig } from '../engine.js';
import {
  buildHelperConnectConfig,
  helperErrorMessage,
  parseHelperCertRequest,
  parseHelperError,
  parseHelperJson,
} from '../engines/helper-protocol.js';

const base: RdpEngineConfig = {
  host: '10.0.0.5',
  port: 3389,
  username: 'alice',
  password: 'pw',
  width: 1280,
  height: 720,
  enableNla: true,
  skipCertVerification: true,
};

describe('buildHelperConnectConfig', () => {
  it('omits gateway when there is none', () => {
    const cfg = buildHelperConnectConfig(base);
    expect('gateway' in cfg).toBe(false);
    expect(cfg).toMatchObject({ host: '10.0.0.5', port: 3389, domain: '', enableGfx: true, drives: [] });
  });

  it('prefers the hostname alias over the host', () => {
    expect(buildHelperConnectConfig({ ...base, hostname: 'pc01.corp.local' }).host).toBe('pc01.corp.local');
  });

  it('sends the gateway with host = gateway hostname', () => {
    const cfg = buildHelperConnectConfig({
      ...base,
      gateway: {
        hostname: 'gw.corp.example',
        port: 8443,
        username: 'gwuser',
        password: 'gw-pw',
        domain: 'CORP',
        transport: 'http',
        bypassLocal: true,
        legacyTls: true,
      },
    });
    expect(cfg.gateway).toEqual({
      host: 'gw.corp.example',
      port: 8443,
      username: 'gwuser',
      password: 'gw-pw',
      domain: 'CORP',
      transport: 'http',
      bypassLocal: true,
      legacyTls: true,
    });
  });

  it('sends the computer\'s old-TLS switch and FreeRDP\'s config folder', () => {
    expect(buildHelperConnectConfig(base)).toMatchObject({ legacyTls: false });
    expect('configDir' in buildHelperConnectConfig(base)).toBe(false);
    expect(buildHelperConnectConfig({ ...base, legacyTls: true }, '/data/freerdp')).toMatchObject({
      legacyTls: true,
      configDir: '/data/freerdp',
    });
  });

  it('never sends the certificate verifier to the helper', () => {
    const cfg = buildHelperConnectConfig({ ...base, verifyCertificate: async () => ({ accept: true }) });
    expect(JSON.stringify(cfg)).not.toContain('verify');
  });
});

describe('parseHelperJson', () => {
  it('parses an object payload', () => {
    expect(parseHelperJson(Buffer.from('{"width":10,"height":20}'))).toEqual({ width: 10, height: 20 });
  });

  it('returns null for malformed or non-object payloads', () => {
    expect(parseHelperJson(Buffer.from('{"message":"bad "quote"}'))).toBeNull();
    expect(parseHelperJson(Buffer.from('42'))).toBeNull();
  });
});

describe('helperErrorMessage', () => {
  it('uses the message field and ignores a code', () => {
    expect(helperErrorMessage(Buffer.from('{"message":"Gateway auth failed","code":2}'))).toBe('Gateway auth failed');
  });

  it('falls back to the raw text when the payload is not valid JSON', () => {
    expect(helperErrorMessage(Buffer.from('{"message":"bad "quote"}'))).toBe('{"message":"bad "quote"}');
  });

  it('gives a generic message for an empty payload', () => {
    expect(helperErrorMessage(Buffer.from(''))).toBe('The RDP helper reported an error.');
  });
});

describe('parseHelperError', () => {
  it('reads the message, code and phase of an ERROR frame', () => {
    const payload = Buffer.from('{"message":"Access denied.","code":131094,"phase":"gateway"}');
    expect(parseHelperError(payload)).toEqual({ message: 'Access denied.', code: 131094, phase: 'gateway' });
  });

  it('drops a phase or code it does not know', () => {
    const payload = Buffer.from('{"message":"x","code":"nope","phase":"moon"}');
    expect(parseHelperError(payload)).toEqual({ message: 'x' });
  });

  it('falls back to the raw text for a malformed frame', () => {
    expect(parseHelperError(Buffer.from('boom'))).toEqual({ message: 'boom' });
  });
});

describe('parseHelperError TLS reasons', () => {
  it('keeps the OpenSSL reason', () => {
    const payload = Buffer.from(JSON.stringify({ message: 'The connection failed at TLS connect.', code: 131080, phase: 'gateway', tls: 'error:0A000102:SSL routines::unsupported protocol' }));
    expect(parseHelperError(payload)).toEqual({
      message: 'The connection failed at TLS connect.',
      code: 131080,
      phase: 'gateway',
      tls: 'error:0A000102:SSL routines::unsupported protocol',
    });
  });

  it('ignores an empty or non-string reason and caps a long one', () => {
    expect(parseHelperError(Buffer.from('{"message":"x","tls":""}'))).toEqual({ message: 'x' });
    expect(parseHelperError(Buffer.from('{"message":"x","tls":5}'))).toEqual({ message: 'x' });
    expect(parseHelperError(Buffer.from(JSON.stringify({ message: 'x', tls: 'a'.repeat(5000) }))).tls).toHaveLength(1024);
  });
});

describe('parseHelperCertRequest', () => {
  const good = { id: 2, host: 'rdg.example.com', port: 443, hop: 'gateway', mismatch: true, changed: false, commonName: 'x', pem: 'PEM' };

  it('reads a CERT_VERIFY frame', () => {
    expect(parseHelperCertRequest(Buffer.from(JSON.stringify(good)))).toEqual({
      id: 2, host: 'rdg.example.com', port: 443, hop: 'gateway', mismatch: true, changed: false, pem: 'PEM',
    });
  });

  it('rejects malformed frames', () => {
    for (const bad of [{ ...good, id: 'x' }, { ...good, host: '' }, { ...good, port: 0 }, { ...good, port: 70000 }, { ...good, hop: 'x' }]) {
      expect(parseHelperCertRequest(Buffer.from(JSON.stringify(bad)))).toBeNull();
    }
    expect(parseHelperCertRequest(Buffer.from('nope'))).toBeNull();
  });

  it('treats a missing pem as empty, so the certificate is refused as unreadable', () => {
    const { pem: _pem, ...noPem } = good;
    expect(parseHelperCertRequest(Buffer.from(JSON.stringify(noPem)))?.pem).toBe('');
  });
});
