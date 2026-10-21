// RDP connect errors carry FreeRDP's code, the failed hop and TLS diagnostics to the renderer inside the error text,
// because invoke() rejections only keep the message. Pure so the renderer can import it.

export type RdpErrorPhase = 'gateway' | 'target';

/** What a plain TCP connect to the failed hop found after a TLS failure with no OpenSSL reason. */
export type RdpNetProbe = 'refused' | 'timeout' | 'unreachable' | 'dns' | 'reset' | 'open';

export interface RdpConnectErrorInfo {
  message: string;
  code?: number;
  phase?: RdpErrorPhase;
  /** The user (or no one, for an agent) did not trust the certificate; the message is already worded for people. */
  certRejected?: boolean;
  net?: RdpNetProbe;
  /** OpenSSL's handshake failure reasons, as logged by FreeRDP. */
  tls?: string;
}

const NET_PROBES: readonly RdpNetProbe[] = ['refused', 'timeout', 'unreachable', 'dns', 'reset', 'open'];

const MARKER_RE =
  /\s*\[rdp-error(?: code=0x([0-9a-f]{1,8}))?(?: phase=(gateway|target))?( cert=rejected)?(?: net=([a-z]+))?(?: tls=([^\s\]]+))?\]$/i;

export function isRdpErrorPhase(value: unknown): value is RdpErrorPhase {
  return value === 'gateway' || value === 'target';
}

export function isRdpNetProbe(value: unknown): value is RdpNetProbe {
  return NET_PROBES.includes(value as RdpNetProbe);
}

export function formatRdpConnectError(info: RdpConnectErrorInfo): string {
  const parts = [
    ...(info.code !== undefined ? [`code=0x${(info.code >>> 0).toString(16).padStart(8, '0')}`] : []),
    ...(info.phase ? [`phase=${info.phase}`] : []),
    ...(info.certRejected ? ['cert=rejected'] : []),
    ...(info.net ? [`net=${info.net}`] : []),
    ...(info.tls ? [`tls=${encodeURIComponent(info.tls)}`] : []),
  ];
  return parts.length ? `${info.message} [rdp-error ${parts.join(' ')}]` : info.message;
}

function decodeTls(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return undefined;
  }
}

export function parseRdpConnectError(raw: string): RdpConnectErrorInfo {
  const m = MARKER_RE.exec(raw);
  if (!m) return { message: raw };
  const net = m[4]?.toLowerCase();
  const tls = m[5] !== undefined ? decodeTls(m[5]) : undefined;
  return {
    message: raw.slice(0, m.index),
    ...(m[1] !== undefined ? { code: parseInt(m[1], 16) } : {}),
    ...(m[2] !== undefined ? { phase: m[2].toLowerCase() as RdpErrorPhase } : {}),
    ...(m[3] !== undefined ? { certRejected: true } : {}),
    ...(isRdpNetProbe(net) ? { net } : {}),
    ...(tls ? { tls } : {}),
  };
}
