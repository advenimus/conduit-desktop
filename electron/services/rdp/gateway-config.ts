/**
 * RD Gateway settings: the shared contract between the renderer, the main
 * process, MCP and the FreeRDP helper.
 *
 * Pure and import-free so the renderer can re-export it (like the knowledge
 * model) and both connect paths resolve a gateway the same way.
 */

export type RdpGatewayMode = 'default' | 'off' | 'custom';
export type RdpGatewayTransport = 'auto' | 'http' | 'rpc';
export type RdpGatewayCredentialMode = 'same' | 'credential';

export const RDP_GATEWAY_DEFAULT_PORT = 443;

/** Gateway keys stored flat on an RDP entry's `config` blob (flat so sync merges each one). */
export interface RdpEntryGatewayFields {
  gatewayMode?: RdpGatewayMode;
  gatewayHostname?: string;
  gatewayPort?: number;
  gatewayTransport?: RdpGatewayTransport;
  gatewayBypassLocal?: boolean;
  gatewayCredentialMode?: RdpGatewayCredentialMode;
  gatewayCredentialId?: string;
}

/** Default gateway kept in Settings > Sessions > RDP (device-local, so no credential id). */
export interface RdpGatewayDefaults {
  gatewayEnabled: boolean;
  gatewayHostname: string;
  gatewayPort: number;
  gatewayTransport: RdpGatewayTransport;
  gatewayBypassLocal: boolean;
}

export const HARDCODED_GATEWAY_DEFAULTS: RdpGatewayDefaults = {
  gatewayEnabled: false,
  gatewayHostname: '',
  gatewayPort: RDP_GATEWAY_DEFAULT_PORT,
  gatewayTransport: 'auto',
  gatewayBypassLocal: false,
};

/** Effective, secret-free gateway settings for one connection. */
export interface RdpGatewaySettings {
  hostname: string;
  port: number;
  transport: RdpGatewayTransport;
  bypassLocal: boolean;
  credentialMode: RdpGatewayCredentialMode;
  credentialId?: string;
  source: 'default' | 'entry';
}

export interface GatewayLogin {
  username: string;
  password: string;
  domain?: string;
}

/** What the RDP engine and helper receive. */
export interface RdpGatewayEngineConfig {
  hostname: string;
  port: number;
  username: string;
  password: string;
  domain: string;
  transport: RdpGatewayTransport;
  bypassLocal: boolean;
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

const TRANSPORTS: readonly RdpGatewayTransport[] = ['auto', 'http', 'rpc'];

function validPort(port: unknown): number | undefined {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function validTransport(t: unknown): RdpGatewayTransport {
  return TRANSPORTS.includes(t as RdpGatewayTransport) ? (t as RdpGatewayTransport) : 'auto';
}

/** Accepts what people paste: "gw", "gw:8443", "https://gw/remoteDesktopGateway/". */
export function normalizeGatewayHost(input: string): { hostname: string; port?: number } {
  let s = (input ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split('/')[0];
  const m = /^([^:[\]]+):(\d{1,5})$/.exec(s);
  if (m) {
    const port = validPort(Number(m[2]));
    return port ? { hostname: m[1], port } : { hostname: m[1] };
  }
  return { hostname: s };
}

/** NTLM wants the domain separately; FreeRDP does not split DOMAIN\user for the gateway. */
export function splitDomainUser(username: string, domain: string): { username: string; domain: string } {
  if (!domain) {
    const i = username.indexOf('\\');
    if (i > 0) return { username: username.slice(i + 1), domain: username.slice(0, i) };
  }
  return { username, domain };
}

export function resolveGatewaySettings(
  fields: RdpEntryGatewayFields,
  defaults: RdpGatewayDefaults,
): RdpGatewaySettings | null {
  const mode: RdpGatewayMode =
    fields.gatewayMode === 'off' || fields.gatewayMode === 'custom' ? fields.gatewayMode : 'default';
  if (mode === 'off') return null;

  const custom = mode === 'custom';
  if (!custom && !defaults.gatewayEnabled) return null;

  const parsed = normalizeGatewayHost(custom ? fields.gatewayHostname ?? '' : defaults.gatewayHostname);
  if (!parsed.hostname) return null;

  // An entry's port field wins; the default's port field is always filled (443), so a port typed into its hostname wins there.
  const port = custom
    ? validPort(fields.gatewayPort) ?? parsed.port
    : parsed.port ?? validPort(defaults.gatewayPort);
  const credentialId = fields.gatewayCredentialId || undefined;
  const credentialMode: RdpGatewayCredentialMode =
    fields.gatewayCredentialMode === 'credential' && credentialId ? 'credential' : 'same';

  return {
    hostname: parsed.hostname,
    port: port ?? RDP_GATEWAY_DEFAULT_PORT,
    transport: validTransport(custom ? fields.gatewayTransport : defaults.gatewayTransport),
    bypassLocal: (custom ? fields.gatewayBypassLocal : defaults.gatewayBypassLocal) === true,
    credentialMode,
    credentialId: credentialMode === 'credential' ? credentialId : undefined,
    source: custom ? 'entry' : 'default',
  };
}

/**
 * Attach the gateway login. `linkedLogin` is the vault credential looked up by
 * `settings.credentialId` (null when it no longer exists).
 */
export function resolveGatewayEngineConfig(
  settings: RdpGatewaySettings,
  hostLogin: GatewayLogin,
  linkedLogin: GatewayLogin | null | undefined,
): RdpGatewayEngineConfig {
  let login: GatewayLogin;
  if (settings.credentialMode === 'credential') {
    if (!linkedLogin?.username) {
      throw new GatewayConfigError(
        'The saved gateway login for this entry was not found. Pick a gateway login again in the entry\'s Gateway settings.',
      );
    }
    login = linkedLogin;
  } else {
    if (!hostLogin.username) {
      throw new GatewayConfigError(
        'The gateway needs a login. Add a username and password to this entry, or pick a saved gateway login in its Gateway settings.',
      );
    }
    login = hostLogin;
  }

  const { username, domain } = splitDomainUser(login.username, login.domain ?? '');
  return {
    hostname: settings.hostname,
    port: settings.port,
    username,
    password: login.password ?? '',
    domain,
    transport: settings.transport,
    bypassLocal: settings.bypassLocal,
  };
}
