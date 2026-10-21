import { describe, expect, it } from 'vitest';
import {
  LEGACY_OPENSSL_CONF,
  MSG,
  TLS_CONNECT_FAILED,
  buildConnectCommand,
  createFrameParser,
  decodeMessage,
  evaluateCase,
} from '../lib/helper-protocol.mjs';

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(type, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v));

describe('buildConnectCommand', () => {
  const base = {
    host: 'desktop',
    port: 3389,
    username: 'deskuser',
    password: 'p"w\\d',
    domain: '',
    width: 1024,
    height: 768,
  };

  it('writes one newline-terminated connect line with the app config keys', () => {
    const line = buildConnectCommand(base);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    const cmd = JSON.parse(line);
    expect(cmd.type).toBe('connect');
    expect(cmd.config).toMatchObject({
      host: 'desktop',
      port: 3389,
      username: 'deskuser',
      password: 'p"w\\d',
      domain: '',
      width: 1024,
      height: 768,
      enableNla: true,
      skipCertVerification: true,
      enableGfx: true,
      enableH264: true,
      drives: [],
      desktopScaleFactor: 100,
      deviceScaleFactor: 100,
      enableClipboard: true,
    });
    expect('gateway' in cmd.config).toBe(false);
  });

  it('adds config.gateway in the helper contract shape', () => {
    const cmd = JSON.parse(
      buildConnectCommand({
        ...base,
        gateway: {
          host: '127.0.0.1',
          port: 18443,
          username: 'gwuser',
          password: 'GwTest-Pass1!',
          domain: '',
          transport: 'auto',
          bypassLocal: false,
        },
      }),
    );
    expect(cmd.config.gateway).toEqual({
      host: '127.0.0.1',
      port: 18443,
      username: 'gwuser',
      password: 'GwTest-Pass1!',
      domain: '',
      transport: 'auto',
      bypassLocal: false,
      legacyTls: false,
    });
  });
});

describe('createFrameParser', () => {
  it('reassembles frames split across chunks and handles several per chunk', () => {
    const seen: Array<[number, string]> = [];
    const parser = createFrameParser((type: number, payload: Buffer) => seen.push([type, payload.toString()]));
    const all = Buffer.concat([
      frame(MSG.CONNECTED, json({ width: 1024, height: 768 })),
      frame(MSG.ERROR, json({ message: 'x' })),
      frame(MSG.CURSOR_NULL, Buffer.alloc(0)),
    ]);
    parser.feed(all.subarray(0, 3));
    parser.feed(all.subarray(3, 20));
    parser.feed(all.subarray(20));
    expect(seen).toEqual([
      [MSG.CONNECTED, '{"width":1024,"height":768}'],
      [MSG.ERROR, '{"message":"x"}'],
      [MSG.CURSOR_NULL, ''],
    ]);
  });
});

describe('decodeMessage', () => {
  it('decodes connected and bitmap frames', () => {
    expect(decodeMessage(MSG.CONNECTED, json({ width: 800, height: 600 }))).toEqual({
      kind: 'connected',
      width: 800,
      height: 600,
    });
    const bmp = Buffer.alloc(8 + 4);
    bmp.writeUInt16LE(1, 0);
    bmp.writeUInt16LE(2, 2);
    bmp.writeUInt16LE(1, 4);
    bmp.writeUInt16LE(1, 6);
    expect(decodeMessage(MSG.BITMAP_UPDATE, bmp)).toEqual({ kind: 'bitmap', x: 1, y: 2, width: 1, height: 1 });
  });

  it('marks an error with valid JSON and a string message as clean', () => {
    expect(decodeMessage(MSG.ERROR, json({ message: 'Gateway said "no"', code: 131094 }))).toEqual({
      kind: 'error',
      message: 'Gateway said "no"',
      code: 131094,
      clean: true,
    });
  });

  it('marks unparseable error JSON as not clean instead of throwing', () => {
    const msg = decodeMessage(MSG.ERROR, Buffer.from('{"message":"bad "quote""}'));
    expect(msg.kind).toBe('error');
    expect(msg.clean).toBe(false);
  });

  it('decodes disconnected with and without an error', () => {
    expect(decodeMessage(MSG.DISCONNECTED, json({ error: null }))).toEqual({
      kind: 'disconnected',
      error: null,
      clean: true,
    });
    expect(decodeMessage(MSG.DISCONNECTED, json({ error: 'boom' }))).toEqual({
      kind: 'disconnected',
      error: 'boom',
      clean: true,
    });
  });
});

describe('evaluateCase', () => {
  const connected = { kind: 'connected', width: 1024, height: 768 };
  const bitmap = { kind: 'bitmap', x: 0, y: 0, width: 64, height: 64 };
  const cleanError = { kind: 'error', message: 'Access denied', code: 1, clean: true };

  it('passes a connect case only with connected and at least one frame', () => {
    expect(evaluateCase('connect', [connected, bitmap]).pass).toBe(true);
    expect(evaluateCase('connect', [connected]).pass).toBe(false);
    expect(evaluateCase('connect', [bitmap]).pass).toBe(false);
    expect(evaluateCase('connect', [connected, bitmap, cleanError]).pass).toBe(false);
  });

  it('passes an error case only with a clean error and no connection', () => {
    expect(evaluateCase('error', [cleanError]).pass).toBe(true);
    expect(evaluateCase('error', [cleanError]).detail).toContain('Access denied');
    expect(evaluateCase('error', [{ kind: 'disconnected', error: 'Gateway down', clean: true }]).pass).toBe(true);
    expect(evaluateCase('error', []).pass).toBe(false);
    expect(evaluateCase('error', [{ ...cleanError, clean: false }]).pass).toBe(false);
    expect(evaluateCase('error', [connected, cleanError]).pass).toBe(false);
  });

  it('does not count a clean disconnect with no error as a failure report', () => {
    expect(evaluateCase('error', [{ kind: 'disconnected', error: null, clean: true }]).pass).toBe(false);
  });
});

describe('certificate questions and TLS reasons', () => {
  it('decodes a CERT_VERIFY frame and an ERROR with an OpenSSL reason', () => {
    expect(decodeMessage(MSG.CERT_VERIFY, json({ id: 3, host: 'h', port: 443, hop: 'gateway', mismatch: true, pem: 'P' }))).toEqual({
      kind: 'cert', id: 3, host: 'h', port: 443, hop: 'gateway', mismatch: true, clean: true,
    });
    expect(decodeMessage(MSG.CERT_VERIFY, Buffer.from('nope'))).toEqual({ kind: 'cert', id: -1, clean: false });
    expect(decodeMessage(MSG.ERROR, json({ message: 'm', code: 1, tls: 'error:x' }))).toEqual({
      kind: 'error', message: 'm', clean: true, code: 1, tls: 'error:x',
    });
  });

  it('checks the OpenSSL reason and a code the case must get past', () => {
    const tlsFail = [{ kind: 'error', message: 'TLS', clean: true, code: TLS_CONNECT_FAILED, tls: 'tlsv1 alert protocol version' }];
    expect(evaluateCase('error', tlsFail, { tls: /protocol version/ }).pass).toBe(true);
    expect(evaluateCase('error', tlsFail, { tls: /renegotiation/ }).pass).toBe(false);
    expect(evaluateCase('error', tlsFail, { notCode: TLS_CONNECT_FAILED }).pass).toBe(false);
    expect(evaluateCase('error', [{ kind: 'error', message: 'nego', clean: true, code: 0x2000c }], { notCode: TLS_CONNECT_FAILED }).pass).toBe(true);
  });

  it('sends the certificate and old-TLS switches', () => {
    const cfg = JSON.parse(
      buildConnectCommand({ host: 'd', port: 3389, username: 'u', password: 'p', skipCertVerification: false, legacyTls: true, gateway: { host: 'g', port: 1, username: 'gu', password: 'gp', legacyTls: true } }),
    ).config;
    expect(cfg).toMatchObject({ skipCertVerification: false, legacyTls: true, gateway: { legacyTls: true } });
  });

  it('uses the same old-server OpenSSL settings as the app', async () => {
    const app = await import('../../../electron/services/rdp/cert-trust/helper-tls-files.js');
    expect(LEGACY_OPENSSL_CONF).toBe(app.LEGACY_OPENSSL_CONF);
  });
});
