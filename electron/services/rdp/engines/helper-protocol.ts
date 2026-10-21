// Pure pieces of the conduit-freerdp helper protocol: the connect command's config and tolerant parsing of its JSON payloads.

import type { RdpEngineConfig } from '../engine.js';
import { isRdpErrorPhase, type RdpConnectErrorInfo } from '../connect-error.js';
import type { HelperCertRequest } from '../cert-trust/cert-trust.js';

export interface HelperGatewayConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  domain: string;
  transport: 'auto' | 'http' | 'rpc';
  bypassLocal: boolean;
  legacyTls: boolean;
}

/** configDir is FreeRDP's config folder (helper-tls-files.ts). */
export function buildHelperConnectConfig(
  config: RdpEngineConfig,
  configDir?: string,
): Record<string, unknown> & { host: string; gateway?: HelperGatewayConfig } {
  const gw = config.gateway;
  return {
    host: config.hostname || config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    domain: config.domain || '',
    width: config.width,
    height: config.height,
    enableNla: config.enableNla,
    skipCertVerification: config.skipCertVerification,
    enableGfx: true,
    enableH264: true,
    drives: (config.sharedFolders || []).map(f => ({
      name: f.name,
      path: f.path,
    })),
    desktopScaleFactor: config.desktopScaleFactor ?? 100,
    deviceScaleFactor: config.deviceScaleFactor ?? 100,
    enableClipboard: config.enableClipboard ?? true,
    legacyTls: config.legacyTls === true,
    ...(configDir ? { configDir } : {}),
    ...(gw
      ? {
          gateway: {
            host: gw.hostname,
            port: gw.port,
            username: gw.username,
            password: gw.password,
            domain: gw.domain,
            transport: gw.transport,
            bypassLocal: gw.bypassLocal,
            legacyTls: gw.legacyTls === true,
          },
        }
      : {}),
  };
}

/** Parsed JSON object, or null when the helper sent something malformed. */
export function parseHelperJson(payload: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(payload.toString());
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorMessageOf(json: Record<string, unknown> | null, payload: Buffer): string {
  if (json && typeof json.message === 'string' && json.message) return json.message;
  const raw = payload.toString().trim();
  return raw || 'The RDP helper reported an error.';
}

/** Text for an ERROR frame; a code field may ride along but the message is what users see. */
export function helperErrorMessage(payload: Buffer): string {
  return errorMessageOf(parseHelperJson(payload), payload);
}

const MAX_TLS_REASON_LENGTH = 1024;

/** An ERROR frame's message plus the FreeRDP code, failed hop and OpenSSL reasons when the helper sent them. */
export function parseHelperError(payload: Buffer): RdpConnectErrorInfo {
  const json = parseHelperJson(payload);
  const code = json?.code;
  const phase = json?.phase;
  const tls = typeof json?.tls === 'string' ? json.tls.trim().slice(0, MAX_TLS_REASON_LENGTH) : '';
  return {
    message: errorMessageOf(json, payload),
    ...(typeof code === 'number' && Number.isInteger(code) && code >= 0 ? { code } : {}),
    ...(isRdpErrorPhase(phase) ? { phase } : {}),
    ...(tls ? { tls } : {}),
  };
}

/** A CERT_VERIFY frame, or null when it is malformed (the helper is then told not to trust). */
export function parseHelperCertRequest(payload: Buffer): HelperCertRequest | null {
  const json = parseHelperJson(payload);
  if (!json) return null;
  const { id, host, port, hop, mismatch, changed, pem } = json;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  if (typeof host !== 'string' || !host) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (hop !== 'gateway' && hop !== 'target') return null;
  return {
    id,
    host,
    port,
    hop,
    mismatch: mismatch === true,
    changed: changed === true,
    pem: typeof pem === 'string' ? pem : '',
  };
}
