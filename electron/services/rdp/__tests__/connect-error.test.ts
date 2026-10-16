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
