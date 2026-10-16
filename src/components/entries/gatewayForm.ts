import type { RdpEntryConfig, RdpGlobalDefaults } from "../../types/entry";
import { normalizeGatewayHost, resolveGatewaySettings, type RdpGatewayTransport } from "../../lib/rdpGateway";

export const GATEWAY_TRANSPORT_OPTIONS: { value: RdpGatewayTransport; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "http", label: "HTTP" },
  { value: "rpc", label: "RPC" },
];

const SERVER_KEYS = ["gatewayHostname", "gatewayPort", "gatewayTransport", "gatewayBypassLocal"] as const;
const LOGIN_KEYS = ["gatewayCredentialMode", "gatewayCredentialId"] as const;

function without(config: Partial<RdpEntryConfig>, keys: readonly (keyof RdpEntryConfig)[]): Partial<RdpEntryConfig> {
  const result = { ...config };
  for (const key of keys) delete result[key];
  return result;
}

/** The entry config to save: keys the chosen gateway mode does not use are dropped. */
export function gatewayConfigForSave(config: Partial<RdpEntryConfig>): Partial<RdpEntryConfig> {
  if (config.gatewayMode === "off") {
    return without(config, [...SERVER_KEYS, ...LOGIN_KEYS]);
  }

  let result = config.gatewayMode === "custom" ? { ...config } : without(config, [...SERVER_KEYS, "gatewayMode"]);
  if (result.gatewayHostname !== undefined) {
    result = { ...result, gatewayHostname: result.gatewayHostname.trim() };
  }
  if (result.gatewayCredentialMode !== "credential") {
    result = without(result, LOGIN_KEYS);
  }
  return result;
}

/** Why the gateway settings cannot be saved, or null. */
export function gatewayValidationError(config: Partial<RdpEntryConfig>): string | null {
  if (config.gatewayMode === "off") return null;
  if (config.gatewayMode === "custom") {
    if (!config.gatewayHostname?.trim()) return "Enter a gateway server, or choose another gateway option.";
    const port = config.gatewayPort;
    if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
      return "The gateway port must be a number from 1 to 65535.";
    }
  }
  if (config.gatewayCredentialMode === "credential" && !config.gatewayCredentialId) {
    return "Pick a saved credential for the gateway login, or use the same login as this computer.";
  }
  return null;
}

/** Turns what people paste ("gw:8443", a URL) into a host, moving a port into an empty Port field. */
export function splitGatewayHostInput(
  input: string,
  currentPort: number | undefined,
): Pick<RdpEntryConfig, "gatewayHostname" | "gatewayPort"> {
  const parsed = normalizeGatewayHost(input);
  return { gatewayHostname: parsed.hostname, gatewayPort: currentPort ?? parsed.port };
}

/** "Default: host:port" for the Settings default gateway, or null when none is on. */
export function describeDefaultGateway(defaults: RdpGlobalDefaults): string | null {
  const settings = resolveGatewaySettings({}, defaults);
  return settings ? `Default: ${settings.hostname}:${settings.port}` : null;
}
