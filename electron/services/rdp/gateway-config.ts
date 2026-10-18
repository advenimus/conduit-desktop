// RD Gateway contract shared by the renderer, main process, MCP and the FreeRDP helper; import-free so the renderer can re-export it.
// A gateway is a credential entry with credential_type 'rd_gateway'. RDP entries point at one with config.gatewayId.

export type RdpGatewayTransport = 'auto' | 'http' | 'rpc';
/** own = typed-in login columns, credential = linked via config.gatewayCredentialId, connection = the RDP entry's login. */
export type RdpGatewayLoginSource = 'own' | 'credential' | 'connection';

export const RD_GATEWAY_CREDENTIAL_TYPE = 'rd_gateway';
export const RDP_GATEWAY_DEFAULT_PORT = 443;

export const GATEWAY_DELETED_MESSAGE =
  'The gateway this entry uses was deleted. Pick a gateway again in the entry\'s Gateway settings.';
export const GATEWAY_PORT_MESSAGE = 'The gateway port must be a number from 1 to 65535.';

export function gatewayNoAddressMessage(name: string): string {
  return `The gateway "${name}" has no server address. Add one in the gateway's settings.`;
}

/** Config keys on a gateway entry (flat so sync merges each one). */
export interface RdGatewayConfig {
  gatewayHostname?: string;
  gatewayPort?: number;
  gatewayTransport?: RdpGatewayTransport;
  gatewayBypassLocal?: boolean;
  gatewayLoginSource?: RdpGatewayLoginSource;
  // In config, not the credential_id column, because team vaults do not sync that column.
  gatewayCredentialId?: string;
}

/** Normalized gateway config; gatewayCredentialId is set only for the 'credential' login. */
export type GatewayConfigView = Required<Omit<RdGatewayConfig, 'gatewayCredentialId'>> & {
  gatewayCredentialId: string | undefined;
};

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

export function validPort(port: unknown): number | undefined {
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function withPort(hostname: string, rawPort: string | undefined): { hostname: string; port?: number } {
  const port = rawPort === undefined ? undefined : validPort(Number(rawPort));
  return port ? { hostname, port } : { hostname };
}

function stripGatewayUrl(input: string): string {
  return (input ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
}

/** True when the input ends in ":<port>" that normalizeGatewayHost would drop, so a save would quietly use 443. */
export function typedGatewayPortInvalid(input: string): boolean {
  const m = /^(?:\[[^\]]*\]|[^:[\]]+):(\d*)$/.exec(stripGatewayUrl(input));
  return m !== null && validPort(Number(m[1])) === undefined;
}

// FreeRDP resolves GatewayHostname with getaddrinfo, so an IPv6 address must be stored without brackets.
/** Accepts what people paste: a host, host:port, [IPv6]:port, a bare IPv6 address, or a gateway URL. */
export function normalizeGatewayHost(input: string): { hostname: string; port?: number } {
  const s = stripGatewayUrl(input);
  const bracketed = /^\[([0-9a-f:.%]+)\](?::(\d{1,5}))?$/i.exec(s);
  if (bracketed) return withPort(bracketed[1], bracketed[2]);
  const hostPort = /^([^:[\]]+):(\d{1,5})$/.exec(s);
  if (hostPort) return withPort(hostPort[1], hostPort[2]);
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

function loginOf(c: Record<string, unknown>, legacyCredentialId: string | undefined): Pick<GatewayConfigView, 'gatewayLoginSource' | 'gatewayCredentialId'> {
  if (c.gatewayLoginSource === 'connection') return { gatewayLoginSource: 'connection', gatewayCredentialId: undefined };
  const linked = nonEmptyString(c.gatewayCredentialId);
  if (c.gatewayLoginSource === 'credential') return { gatewayLoginSource: 'credential', gatewayCredentialId: linked };
  // Builds before the config link stored it in the credential_id column with source 'own' or no source.
  const legacy = linked ?? legacyCredentialId;
  return legacy ? { gatewayLoginSource: 'credential', gatewayCredentialId: legacy } : { gatewayLoginSource: 'own', gatewayCredentialId: undefined };
}

/** Secret-free view of a gateway's config; legacyCredentialId is its credential_id column, for gateways saved before the config link. */
export function readGatewayConfig(config: unknown, legacyCredentialId?: string | null): GatewayConfigView {
  const c = typeof config === 'object' && config !== null ? (config as Record<string, unknown>) : {};
  const parsed = normalizeGatewayHost(typeof c.gatewayHostname === 'string' ? c.gatewayHostname : '');
  return {
    gatewayHostname: parsed.hostname,
    // A port field wins over a port typed into the server box.
    gatewayPort: validPort(c.gatewayPort) ?? parsed.port ?? RDP_GATEWAY_DEFAULT_PORT,
    gatewayTransport: validTransport(c.gatewayTransport),
    gatewayBypassLocal: c.gatewayBypassLocal === true,
    ...loginOf(c, nonEmptyString(legacyCredentialId)),
  };
}

/** "gw.corp.example", "gw.corp.example:8443" or "[2001:db8::1]:8443" (443 is left off). */
export function describeGatewayAddress(config: unknown): string {
  const g = readGatewayConfig(config);
  if (!g.gatewayHostname) return '';
  const host = g.gatewayHostname.includes(':') ? `[${g.gatewayHostname}]` : g.gatewayHostname;
  return g.gatewayPort === RDP_GATEWAY_DEFAULT_PORT ? host : `${host}:${g.gatewayPort}`;
}

/** The engine config for an RDP entry pointing at gatewayId (gateway is null when gone); throws GatewayConfigError for the user. */
export function resolveGatewayEngineConfig(
  gatewayId: string,
  gateway: RdGatewayRecord | null,
  hostLogin: GatewayLogin,
): RdpGatewayEngineConfig {
  if (!gateway || gateway.id !== gatewayId || !isRdGateway({ entry_type: gateway.entryType, credential_type: gateway.credentialType })) {
    throw new GatewayConfigError(GATEWAY_DELETED_MESSAGE);
  }
  const g = readGatewayConfig(gateway.config);
  if (!g.gatewayHostname) {
    throw new GatewayConfigError(gatewayNoAddressMessage(gateway.name));
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
