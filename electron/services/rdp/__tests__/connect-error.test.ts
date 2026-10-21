import { describe, it, expect } from 'vitest';
import { formatRdpConnectError, parseRdpConnectError } from '../connect-error.js';

describe('formatRdpConnectError / parseRdpConnectError', () => {
  it('keeps the message and adds a marker with the code and phase', () => {
    const raw = formatRdpConnectError({ message: 'Access denied.', code: 0x00020016, phase: 'gateway' });
    expect(raw.startsWith('Access denied.')).toBe(true);
    expect(parseRdpConnectError(raw)).toEqual({ message: 'Access denied.', code: 0x00020016, phase: 'gateway' });
  });

  it('round-trips a target phase and a large HRESULT code', () => {
    const raw = formatRdpConnectError({ message: 'E_PROXY_NAP_ACCESSDENIED', code: 0x800759da, phase: 'target' });
    expect(parseRdpConnectError(raw)).toEqual({ message: 'E_PROXY_NAP_ACCESSDENIED', code: 0x800759da, phase: 'target' });
  });

  it('adds no marker when there is no code or phase', () => {
    expect(formatRdpConnectError({ message: 'Connection failed' })).toBe('Connection failed');
  });

  it('reads a plain message as having no code or phase', () => {
    expect(parseRdpConnectError('The connection failed at TLS connect.')).toEqual({
      message: 'The connection failed at TLS connect.',
    });
  });

  it('keeps a code without a phase', () => {
    const raw = formatRdpConnectError({ message: 'Connection failed', code: 6 });
    expect(parseRdpConnectError(raw)).toEqual({ message: 'Connection failed', code: 6 });
  });
});

describe('TLS diagnostics in the marker', () => {
  const tls = 'error:0A00042E:SSL routines:ssl3_read_bytes:tlsv1 alert protocol version:ssl/record/rec_layer_s3.c:908:SSL alert number 70';

  it('round-trips an OpenSSL reason with spaces, colons and brackets', () => {
    const info = { message: 'The connection failed at TLS connect.', code: 0x00020008, phase: 'gateway' as const, tls: `${tls} [x]` };
    expect(parseRdpConnectError(formatRdpConnectError(info))).toEqual(info);
  });

  it('round-trips a port check and a rejected certificate', () => {
    const info = { message: 'You chose not to trust it.', phase: 'gateway' as const, certRejected: true, net: 'refused' as const };
    expect(parseRdpConnectError(formatRdpConnectError(info))).toEqual(info);
  });

  it('drops an unknown port check and a broken encoding', () => {
    expect(parseRdpConnectError('x [rdp-error net=bogus]')).toEqual({ message: 'x' });
    expect(parseRdpConnectError('x [rdp-error code=0x00020008 tls=%E0%A4%A]')).toEqual({ message: 'x', code: 0x00020008 });
  });
});
