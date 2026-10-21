import { describe, it, expect } from 'vitest';
import { classifyTlsReason, rdpTlsAdvice } from '../tls-advice.js';

// Reasons as the helper reported them against scripts/gateway-test (legacy-up.sh) and as OpenSSL 3 words them.
const REASONS: [string, ReturnType<typeof classifyTlsReason>][] = [
  ['error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version:ssl/record/rec_layer_s3.c:908:SSL alert number 70', 'old-tls'],
  ['error:0A000102:SSL routines::unsupported protocol', 'old-tls'],
  ['error:0A0000BF:SSL routines::no protocols available', 'old-tls'],
  ['error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled', 'renegotiation'],
  ['error:0A00018E:SSL routines::ca md too weak', 'weak-crypto'],
  ['error:0A00018F:SSL routines::ee key too small', 'weak-crypto'],
  ['error:0A00018A:SSL routines::dh key too small', 'weak-crypto'],
  ['error:0A00045C:SSL routines::tlsv13 alert certificate required', 'client-cert'],
  ['error:0A000410:SSL routines::sslv3 alert handshake failure', 'handshake-refused'],
  ['error:0A00010B:SSL routines::wrong version number', 'not-tls'],
  ['error:0A000126:SSL routines::unexpected eof while reading', 'closed'],
  ['error:12345678:something new', undefined],
];

describe('classifyTlsReason', () => {
  it.each(REASONS)('%s', (reason, problem) => {
    expect(classifyTlsReason(reason)).toBe(problem);
  });
});

describe('rdpTlsAdvice', () => {
  const oldTls = REASONS[0][0];

  it('points at the gateway switch when the gateway hop failed', () => {
    const advice = rdpTlsAdvice({ message: 'x', phase: 'gateway', tls: oldTls }, true);
    expect(advice).toContain('old TLS version');
    expect(advice).toContain("gateway's settings");
  });

  it('points at the entry switch for a direct connection or the computer hop', () => {
    expect(rdpTlsAdvice({ message: 'x', tls: oldTls }, false)).toContain("this entry's Security settings");
    expect(rdpTlsAdvice({ message: 'x', phase: 'target', tls: oldTls }, true)).toContain("this entry's Security settings");
  });

  it('uses the port check when OpenSSL gave no reason', () => {
    expect(rdpTlsAdvice({ message: 'x', phase: 'gateway', net: 'refused' }, true)).toContain('Nothing is listening');
    expect(rdpTlsAdvice({ message: 'x', phase: 'gateway', net: 'open' }, true)).toContain('Allow old TLS');
    expect(rdpTlsAdvice({ message: 'x', net: 'unreachable' }, false)).toContain('Local Network');
  });

  it('prefers the OpenSSL reason over the port check', () => {
    expect(rdpTlsAdvice({ message: 'x', net: 'open', tls: oldTls }, false)).toContain('old TLS version');
  });

  it('says nothing for a rejected certificate or an error without diagnostics', () => {
    expect(rdpTlsAdvice({ message: 'x', certRejected: true, tls: oldTls }, false)).toBeUndefined();
    expect(rdpTlsAdvice({ message: 'x' }, false)).toBeUndefined();
    expect(rdpTlsAdvice({ message: 'x', tls: 'error:12345678:something new' }, false)).toBeUndefined();
  });
});
