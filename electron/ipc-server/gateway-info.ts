/**
 * Secret-free RD Gateway fields for entry_info: which gateway an RDP entry
 * uses, or a gateway entry's own settings.
 */

import { describeGatewayAddress, gatewayIdOf, isRdGateway, readGatewayConfig } from '../services/rdp/gateway-config.js';

interface InfoEntry {
  id: string;
  name: string;
  entry_type: string;
  credential_type: string | null;
  config: Record<string, unknown> | null;
}

/** The vault's metadata getter (no secrets). It throws when the id is unknown. */
export interface GatewayInfoVault {
  getEntryMeta(id: string): InfoEntry;
}

export function gatewayInfo(vault: GatewayInfoVault, entry: InfoEntry): Record<string, unknown> {
  if (isRdGateway(entry)) {
    const g = readGatewayConfig(entry.config);
    return {
      gateway_settings: {
        address: describeGatewayAddress(entry.config),
        hostname: g.gatewayHostname,
        port: g.gatewayPort,
        transport: g.gatewayTransport,
        bypass_local: g.gatewayBypassLocal,
        login_source: g.gatewayLoginSource === 'connection' ? 'rdp_entry' : 'gateway',
      },
    };
  }

  const gatewayId = entry.entry_type === 'rdp' ? gatewayIdOf(entry.config) : undefined;
  if (!gatewayId) return {};
  let gateway: InfoEntry | null = null;
  try {
    gateway = vault.getEntryMeta(gatewayId);
  } catch {
    gateway = null;
  }
  if (!gateway || !isRdGateway(gateway)) {
    return { gateway: { id: gatewayId, name: null, address: null, missing: true } };
  }
  return { gateway: { id: gateway.id, name: gateway.name, address: describeGatewayAddress(gateway.config) } };
}
