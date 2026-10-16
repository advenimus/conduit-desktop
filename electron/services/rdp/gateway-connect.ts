/**
 * Main-process side of the RD Gateway contract: looks up the gateway entry an
 * RDP entry points at, resolves its login from the vault, and builds the
 * engine config. Shared by rdp_connect and MCP connection_open_entry.
 * Electron-free so it can be tested.
 */

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

/** The vault's entry getter. It throws when the id is unknown. */
export interface GatewayVault {
  getEntry(id: string): GatewayVaultEntry;
}

function tryGetEntry(vault: GatewayVault, id: string): GatewayVaultEntry | null {
  try {
    return vault.getEntry(id) ?? null;
  } catch {
    return null;
  }
}

function loginFrom(stored: StoredLogin): GatewayLogin | null {
  if (!stored.username && !stored.password) return null;
  return { username: stored.username ?? '', password: stored.password ?? '', domain: stored.domain ?? undefined };
}

/** The gateway entry with this id, or null when it is gone or not a gateway. */
export function findRdGatewayEntry(vault: GatewayVault, gatewayId: string): GatewayVaultEntry | null {
  const entry = tryGetEntry(vault, gatewayId);
  return entry && isRdGateway(entry) ? entry : null;
}

/**
 * A gateway's own login: the linked credential when one is set, else the
 * typed-in fields. A link to a missing credential gives no login rather than
 * stale typed-in values. Folder inheritance never applies to a gateway.
 */
function ownLoginOf(vault: GatewayVault, gateway: GatewayVaultEntry): GatewayLogin | null {
  if (gateway.credential_id) {
    const cred = tryGetEntry(vault, gateway.credential_id);
    return cred && cred.entry_type === 'credential' ? loginFrom(cred) : null;
  }
  return loginFrom(gateway);
}

/** Reads any entry by id as a gateway record; resolveGatewayEngineConfig checks that it is one. */
export function loadRdGatewayRecord(vault: GatewayVault, gatewayId: string): RdGatewayRecord | null {
  const entry = tryGetEntry(vault, gatewayId);
  if (!entry) return null;
  const config = entry.config ?? {};
  const usesOwnLogin = isRdGateway(entry) && readGatewayConfig(config).gatewayLoginSource === 'own';
  return {
    id: entry.id,
    name: entry.name,
    entryType: entry.entry_type,
    credentialType: entry.credential_type,
    config,
    ownLogin: usesOwnLogin ? ownLoginOf(vault, entry) : null,
  };
}

/** Validates the gatewayId arg of rdp_connect; it crosses the IPC boundary. */
export function parseGatewayIdArg(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new GatewayConfigError('The gateway setting is not valid.');
  return raw.trim() || undefined;
}

/**
 * The engine gateway config for an RDP entry, or undefined for a direct
 * connection. Throws GatewayConfigError with a message for the user.
 */
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
  return `gateway=${gw.hostname}:${gw.port} transport=${gw.transport} bypassLocal=${gw.bypassLocal} user=${gw.username ? 'set' : 'none'}`;
}
