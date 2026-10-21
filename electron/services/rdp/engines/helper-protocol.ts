// Pure pieces of the conduit-freerdp helper protocol: the connect command's config and tolerant parsing of its JSON payloads.

import type { RdpEngineConfig } from '../engine.js';
import { isRdpErrorPhase, type RdpConnectErrorInfo } from '../connect-error.js';

export interface HelperGatewayConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  domain: string;
  transport: 'auto' | 'http' | 'rpc';
  bypassLocal: boolean;
}

export function buildHelperConnectConfig(config: RdpEngineConfig): Record<string, unknown> & { host: string; gateway?: HelperGatewayConfig } {
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

/** A DISCONNECTED frame: the error text, and the server's ERRINFO reason when the helper sent one. */
export function parseHelperDisconnect(payload: Buffer): { error: string | null; errorInfo: number | null } {
  const json = parseHelperJson(payload);
  if (!json) return { error: payload.toString().trim() || null, errorInfo: null };
  return {
    error: typeof json.error === 'string' && json.error ? json.error : null,
    errorInfo: typeof json.errorInfo === 'number' ? json.errorInfo : null,
  };
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

/** An ERROR frame's message plus the FreeRDP code and failed hop when the helper sent them. */
export function parseHelperError(payload: Buffer): RdpConnectErrorInfo {
  const json = parseHelperJson(payload);
  const code = json?.code;
  const phase = json?.phase;
  return {
    message: errorMessageOf(json, payload),
    ...(typeof code === 'number' && Number.isInteger(code) && code >= 0 ? { code } : {}),
    ...(isRdpErrorPhase(phase) ? { phase } : {}),
  };
}
