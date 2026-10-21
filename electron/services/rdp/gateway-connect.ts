// Main-process side of the RD Gateway contract, shared by rdp_connect and MCP connection_open_entry; Electron-free for tests.

import {
  GatewayConfigError,
  isRdGateway,
  readGatewayConfig,
  resolveGatewayEngineConfig,
  type GatewayLogin,
  type RdGatewayRecord,
  type RdpGatewayEngineConfig,
} from './gateway-config.js';

export interface StoredLogin {
  username?: string | null;
  password?: string | null;
  domain?: string | null;
}

/** The fields of a decrypted vault entry this module reads. */
export interface GatewayVaultEntry extends StoredLogin {
  id: string;
  name: string;
  entry_type: string;
  credential_type: string | null;
  config: Record<string, unknown> | null;
  credential_id: string | null;
}

/** The vault's entry getter. It throws "Entry not found: <id>" when the id is unknown. */
export interface GatewayVault {
  getEntry(id: string): GatewayVaultEntry;
}

// ConduitVault.getEntry and getEntryMeta throw this for an unknown id; anything else is a vault fault.
const NOT_FOUND_RE = /^Entry not found\b/;

export function isEntryNotFound(e: unknown): boolean {
  return e instanceof Error && NOT_FOUND_RE.test(e.message);
}

function tryGetEntry(vault: GatewayVault, id: string): GatewayVaultEntry | null {
  try {
    return vault.getEntry(id) ?? null;
  } catch (e) {
    if (isEntryNotFound(e)) return null;
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[RDP] Could not read gateway entry ${id} from the vault:`, e);
    throw new GatewayConfigError(`Could not read the gateway from the vault: ${reason}`);
  }
}

function loginFrom(stored: StoredLogin): GatewayLogin | null {
  if (!stored.username && !stored.password) return null;
  return { username: stored.username ?? '', password: stored.password ?? '', domain: stored.domain ?? undefined };
}

/** The gateway entry with this id, or null when it is gone or not a gateway. Throws GatewayConfigError when the vault fails. */
export function findRdGatewayEntry(vault: GatewayVault, gatewayId: string): GatewayVaultEntry | null {
  const entry = tryGetEntry(vault, gatewayId);
  return entry && isRdGateway(entry) ? entry : null;
}

// A link to a missing credential gives no login rather than stale typed-in values; folder inheritance never applies.
function ownLoginOf(vault: GatewayVault, gateway: GatewayVaultEntry): GatewayLogin | null {
  const g = readGatewayConfig(gateway.config, gateway.credential_id);
  if (g.gatewayLoginSource === 'connection') return null;
  if (g.gatewayLoginSource === 'own') return loginFrom(gateway);
  if (!g.gatewayCredentialId) return null;
  const cred = tryGetEntry(vault, g.gatewayCredentialId);
  return cred && cred.entry_type === 'credential' && !isRdGateway(cred) ? loginFrom(cred) : null;
}

/** Reads any entry by id as a gateway record; resolveGatewayEngineConfig checks that it is one. */
export function loadRdGatewayRecord(vault: GatewayVault, gatewayId: string): RdGatewayRecord | null {
  const entry = tryGetEntry(vault, gatewayId);
  if (!entry) return null;
  const config = entry.config ?? {};
  return {
    id: entry.id,
    name: entry.name,
    entryType: entry.entry_type,
    credentialType: entry.credential_type,
    config,
    ownLogin: isRdGateway(entry) ? ownLoginOf(vault, entry) : null,
  };
}

/** Validates the gatewayId arg of rdp_connect; it crosses the IPC boundary. */
export function parseGatewayIdArg(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new GatewayConfigError('The gateway setting is not valid.');
  return raw.trim() || undefined;
}

/** The engine gateway config for an RDP entry, or undefined for a direct connection. Throws GatewayConfigError for the user. */
export function connectGateway(
  gatewayId: string | undefined,
  hostLogin: StoredLogin,
  vault: GatewayVault,
): RdpGatewayEngineConfig | undefined {
  if (!gatewayId) return undefined;
  return resolveGatewayEngineConfig(gatewayId, loadRdGatewayRecord(vault, gatewayId), {
    username: hostLogin.username ?? '',
    password: hostLogin.password ?? '',
    domain: hostLogin.domain ?? undefined,
  });
}

/** One log-safe line; never includes the password. */
export function describeGateway(gw: RdpGatewayEngineConfig): string {
  return `gateway=${gw.hostname}:${gw.port} transport=${gw.transport} bypassLocal=${gw.bypassLocal} legacyTls=${gw.legacyTls} user=${gw.username ? 'set' : 'none'}`;
}
