/**
 * RD Gateway contract shared by the renderer, the main process, MCP and the
 * FreeRDP helper.
 *
 * A gateway is its own vault object: a credential entry with
 * credential_type 'rd_gateway'. Its login uses the normal entry login fields
 * (typed in or a linked credential) unless it is set to use the RDP entry's
 * own login. RDP entries point at one with config.gatewayId.
 *
 * Pure and import-free so the renderer can re-export it (like the knowledge
 * model) and every connect path resolves a gateway the same way.
 */

export type RdpGatewayTransport = 'auto' | 'http' | 'rpc';
export type RdpGatewayLoginSource = 'own' | 'connection';

export const RD_GATEWAY_CREDENTIAL_TYPE = 'rd_gateway';
export const RDP_GATEWAY_DEFAULT_PORT = 443;

/** Config keys on a gateway entry (flat so sync merges each one). */
export interface RdGatewayConfig {
  gatewayHostname?: string;
  gatewayPort?: number;
  gatewayTransport?: RdpGatewayTransport;
  gatewayBypassLocal?: boolean;
  gatewayLoginSource?: RdpGatewayLoginSource;
}

/** Config key on an RDP entry. */
export interface RdpEntryGatewayFields {
  gatewayId?: string;
}

export interface GatewayLogin {
  username: string;
  password: string;
  domain?: string;
}

/** A gateway entry as read from the vault, with its own login already resolved (linked or typed in). */
export interface RdGatewayRecord {
  id: string;
  name: string;
  entryType: string;
  credentialType: string | null;
  config: RdGatewayConfig | Record<string, unknown>;
  ownLogin: GatewayLogin | null;
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

export function validTransport(t: unknown): RdpGatewayTransport {
  return TRANSPORTS.includes(t as RdpGatewayTransport) ? (t as RdpGatewayTransport) : 'auto';
}

export function isRdGateway(entry: { entry_type?: string | null; credential_type?: string | null }): boolean {
  return entry.entry_type === 'credential' && entry.credential_type === RD_GATEWAY_CREDENTIAL_TYPE;
}

/** The gateway id an RDP entry points at, or undefined. Tolerates junk from other clients. */
export function gatewayIdOf(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const id = (config as Record<string, unknown>).gatewayId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
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

/** Normalized, secret-free view of a gateway entry's config, for forms and summaries. */
export function readGatewayConfig(config: unknown): Required<RdGatewayConfig> {
  const c = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const parsed = normalizeGatewayHost(typeof c.gatewayHostname === 'string' ? c.gatewayHostname : '');
  return {
    gatewayHostname: parsed.hostname,
    // A port field wins over a port typed into the server box.
    gatewayPort: validPort(c.gatewayPort) ?? parsed.port ?? RDP_GATEWAY_DEFAULT_PORT,
    gatewayTransport: validTransport(c.gatewayTransport),
    gatewayBypassLocal: c.gatewayBypassLocal === true,
    gatewayLoginSource: c.gatewayLoginSource === 'connection' ? 'connection' : 'own',
  };
}

/** "gw.corp.example" or "gw.corp.example:8443" (443 is left off). */
export function describeGatewayAddress(config: unknown): string {
  const g = readGatewayConfig(config);
  if (!g.gatewayHostname) return '';
  return g.gatewayPort === RDP_GATEWAY_DEFAULT_PORT ? g.gatewayHostname : `${g.gatewayHostname}:${g.gatewayPort}`;
}

/**
 * Builds the engine gateway config for an RDP entry that points at `gatewayId`.
 * `gateway` is the looked-up record (null when the entry no longer exists).
 * Throws GatewayConfigError with a message meant for the user.
 */
export function resolveGatewayEngineConfig(
  gatewayId: string,
  gateway: RdGatewayRecord | null,
  hostLogin: GatewayLogin,
): RdpGatewayEngineConfig {
  if (!gateway || gateway.id !== gatewayId || !isRdGateway({ entry_type: gateway.entryType, credential_type: gateway.credentialType })) {
    throw new GatewayConfigError(
      'The gateway this entry uses was deleted. Pick a gateway again in the entry\'s Gateway settings.',
    );
  }
  const g = readGatewayConfig(gateway.config);
  if (!g.gatewayHostname) {
    throw new GatewayConfigError(`The gateway "${gateway.name}" has no server address. Add one in the gateway's settings.`);
  }

  let login: GatewayLogin;
  if (g.gatewayLoginSource === 'connection') {
    if (!hostLogin.username) {
      throw new GatewayConfigError(
        `The gateway "${gateway.name}" uses the login of the RDP entry, but this entry has no username. Add a login to the entry.`,
      );
    }
    login = hostLogin;
  } else {
    if (!gateway.ownLogin?.username) {
      throw new GatewayConfigError(
        `The gateway "${gateway.name}" has no login. Add one in the gateway's settings, or set it to use the RDP entry's login.`,
      );
    }
    login = gateway.ownLogin;
  }

  const { username, domain } = splitDomainUser(login.username, login.domain ?? '');
  return {
    hostname: g.gatewayHostname,
    port: g.gatewayPort,
    username,
    password: login.password ?? '',
    domain,
    transport: g.gatewayTransport,
    bypassLocal: g.gatewayBypassLocal,
  };
}
