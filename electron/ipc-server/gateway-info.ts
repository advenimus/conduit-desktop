// Secret-free RD Gateway fields for entry_info: which gateway an RDP entry uses, or a gateway entry's own settings.

import { describeGatewayAddress, gatewayIdOf, isRdGateway, readGatewayConfig } from '../services/rdp/gateway-config.js';
import { isEntryNotFound } from '../services/rdp/gateway-connect.js';

interface InfoEntry {
  id: string;
  name: string;
  entry_type: string;
  credential_type: string | null;
  config: Record<string, unknown> | null;
  credential_id?: string | null;
}

/** The vault's metadata getter (no secrets). It throws "Entry not found: <id>" when the id is unknown. */
export interface GatewayInfoVault {
  getEntryMeta(id: string): InfoEntry;
}

const LOGIN_SOURCE_NAMES = { own: 'gateway', credential: 'saved_credential', connection: 'rdp_entry' } as const;

function findEntryMeta(vault: GatewayInfoVault, id: string): InfoEntry | null {
  try {
    return vault.getEntryMeta(id);
  } catch (e) {
    if (isEntryNotFound(e)) return null;
    throw e;
  }
}

export function gatewayInfo(vault: GatewayInfoVault, entry: InfoEntry): Record<string, unknown> {
  if (isRdGateway(entry)) {
    const g = readGatewayConfig(entry.config, entry.credential_id);
    return {
      gateway_settings: {
        address: describeGatewayAddress(entry.config),
        hostname: g.gatewayHostname,
        port: g.gatewayPort,
        transport: g.gatewayTransport,
        bypass_local: g.gatewayBypassLocal,
        login_source: LOGIN_SOURCE_NAMES[g.gatewayLoginSource],
        ...(g.gatewayCredentialId ? { credential_id: g.gatewayCredentialId } : {}),
      },
    };
  }

  const gatewayId = entry.entry_type === 'rdp' ? gatewayIdOf(entry.config) : undefined;
  if (!gatewayId) return {};
  const gateway = findEntryMeta(vault, gatewayId);
  if (!gateway || !isRdGateway(gateway)) {
    return { gateway: { id: gatewayId, name: null, address: null, missing: true } };
  }
  return { gateway: { id: gateway.id, name: gateway.name, address: describeGatewayAddress(gateway.config) } };
}
