/**
 * Main-process side of the RD Gateway contract: checks the secret-free
 * settings the renderer sends, reads the device defaults, and attaches the
 * gateway login looked up from the vault. Electron-free so it can be tested.
 */

import {
  GatewayConfigError,
  HARDCODED_GATEWAY_DEFAULTS,
  RDP_GATEWAY_DEFAULT_PORT,
  normalizeGatewayHost,
  resolveGatewayEngineConfig,
  type GatewayLogin,
  type RdpGatewayDefaults,
  type RdpGatewayEngineConfig,
  type RdpGatewaySettings,
  type RdpGatewayTransport,
} from './gateway-config.js';

export interface StoredLogin {
  username?: string | null;
  password?: string | null;
  domain?: string | null;
}

/** Finds a vault credential by id. May throw or return null when it is gone. */
export type CredentialLookup = (id: string) => StoredLogin | null | undefined;

const TRANSPORTS: readonly RdpGatewayTransport[] = ['auto', 'http', 'rpc'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

function isTransport(v: unknown): v is RdpGatewayTransport {
  return TRANSPORTS.includes(v as RdpGatewayTransport);
}

/** Gateway defaults from a stored `session_defaults_rdp` value; older files lack the keys. */
export function gatewayDefaultsFrom(raw: unknown): RdpGatewayDefaults {
  const r = isRecord(raw) ? raw : {};
  const d = HARDCODED_GATEWAY_DEFAULTS;
  return {
    gatewayEnabled: typeof r.gatewayEnabled === 'boolean' ? r.gatewayEnabled : d.gatewayEnabled,
    gatewayHostname: typeof r.gatewayHostname === 'string' ? r.gatewayHostname : d.gatewayHostname,
    gatewayPort: isPort(r.gatewayPort) ? r.gatewayPort : d.gatewayPort,
    gatewayTransport: isTransport(r.gatewayTransport) ? r.gatewayTransport : d.gatewayTransport,
    gatewayBypassLocal: typeof r.gatewayBypassLocal === 'boolean' ? r.gatewayBypassLocal : d.gatewayBypassLocal,
  };
}

/** Validates the `gateway` arg of rdp_connect; it crosses the IPC boundary. */
export function parseGatewaySettingsArg(raw: unknown): RdpGatewaySettings | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new GatewayConfigError('The gateway settings are not valid.');

  const { hostname } = normalizeGatewayHost(typeof raw.hostname === 'string' ? raw.hostname : '');
  if (!hostname) {
    throw new GatewayConfigError('The gateway address is missing. Add it in the Gateway settings.');
  }
  const credentialId = typeof raw.credentialId === 'string' && raw.credentialId ? raw.credentialId : undefined;
  const credentialMode = raw.credentialMode === 'credential' && credentialId ? 'credential' : 'same';
  return {
    hostname,
    port: isPort(raw.port) ? raw.port : RDP_GATEWAY_DEFAULT_PORT,
    transport: isTransport(raw.transport) ? raw.transport : 'auto',
    bypassLocal: raw.bypassLocal === true,
    credentialMode,
    credentialId: credentialMode === 'credential' ? credentialId : undefined,
    source: raw.source === 'default' ? 'default' : 'entry',
  };
}

function findLinkedLogin(settings: RdpGatewaySettings, lookup: CredentialLookup): GatewayLogin | null {
  if (settings.credentialMode !== 'credential' || !settings.credentialId) return null;
  let cred: StoredLogin | null | undefined;
  try {
    cred = lookup(settings.credentialId);
  } catch {
    return null;
  }
  if (!cred) return null;
  return { username: cred.username ?? '', password: cred.password ?? '', domain: cred.domain ?? undefined };
}

/**
 * Turns effective settings into the engine config, or undefined for a direct
 * connection. Throws GatewayConfigError when no gateway login is available.
 */
export function connectGateway(
  settings: RdpGatewaySettings | null | undefined,
  hostLogin: StoredLogin,
  lookup: CredentialLookup,
): RdpGatewayEngineConfig | undefined {
  if (!settings) return undefined;
  return resolveGatewayEngineConfig(
    settings,
    {
      username: hostLogin.username ?? '',
      password: hostLogin.password ?? '',
      domain: hostLogin.domain ?? undefined,
    },
    findLinkedLogin(settings, lookup),
  );
}

/** One log-safe line; never includes the password. */
export function describeGateway(gw: RdpGatewayEngineConfig): string {
  return `gateway=${gw.hostname}:${gw.port} transport=${gw.transport} bypassLocal=${gw.bypassLocal} user=${gw.username ? 'set' : 'none'}`;
}
