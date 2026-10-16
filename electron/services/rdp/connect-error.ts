// RDP connect errors carry FreeRDP's code and the failed hop to the renderer inside the error text,
// because invoke() rejections only keep the message. Pure so the renderer can import it.

export type RdpErrorPhase = 'gateway' | 'target';

export interface RdpConnectErrorInfo {
  message: string;
  code?: number;
  phase?: RdpErrorPhase;
}

const MARKER_RE = /\s*\[rdp-error(?: code=0x([0-9a-f]{1,8}))?(?: phase=(gateway|target))?\]$/i;

export function isRdpErrorPhase(value: unknown): value is RdpErrorPhase {
  return value === 'gateway' || value === 'target';
}

export function formatRdpConnectError(info: RdpConnectErrorInfo): string {
  const parts = [
    ...(info.code !== undefined ? [`code=0x${(info.code >>> 0).toString(16).padStart(8, '0')}`] : []),
    ...(info.phase ? [`phase=${info.phase}`] : []),
  ];
  return parts.length ? `${info.message} [rdp-error ${parts.join(' ')}]` : info.message;
}

export function parseRdpConnectError(raw: string): RdpConnectErrorInfo {
  const m = MARKER_RE.exec(raw);
  if (!m) return { message: raw };
  return {
    message: raw.slice(0, m.index),
    ...(m[1] !== undefined ? { code: parseInt(m[1], 16) } : {}),
    ...(m[2] !== undefined ? { phase: m[2].toLowerCase() as RdpErrorPhase } : {}),
  };
}
