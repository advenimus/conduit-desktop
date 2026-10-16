import type { EntryMeta, RdpEntryConfig } from "../../types/entry";
import {
  describeGatewayAddress,
  gatewayIdOf,
  isRdGateway,
  normalizeGatewayHost,
  readGatewayConfig,
  type RdGatewayConfig,
  type RdpGatewayTransport,
} from "../../lib/rdpGateway";

export const GATEWAY_TRANSPORT_OPTIONS: { value: RdpGatewayTransport; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "http", label: "HTTP" },
  { value: "rpc", label: "RPC" },
];

/** How a gateway signs in: a typed-in login, a linked credential, or the RDP entry's own login. */
export type GatewayLoginChoice = "typed" | "saved" | "connection";

/** Per-entry gateway keys from before gateways were their own objects. */
const LEGACY_RDP_GATEWAY_KEYS = [
  "gatewayMode",
  "gatewayHostname",
  "gatewayPort",
  "gatewayTransport",
  "gatewayBypassLocal",
  "gatewayCredentialMode",
  "gatewayCredentialId",
] as const;

function validPort(port: unknown): boolean {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The config to save on a gateway entry: only the RdGatewayConfig keys, defaults left out. */
export function gatewayEntryConfigForSave(config: Partial<RdGatewayConfig>, login: GatewayLoginChoice): RdGatewayConfig {
  const parsed = normalizeGatewayHost(config.gatewayHostname ?? "");
  const port = config.gatewayPort ?? parsed.port;
  return {
    gatewayHostname: parsed.hostname,
    ...(port !== undefined ? { gatewayPort: port } : {}),
    ...(config.gatewayTransport && config.gatewayTransport !== "auto" ? { gatewayTransport: config.gatewayTransport } : {}),
    ...(config.gatewayBypassLocal === true ? { gatewayBypassLocal: true } : {}),
    gatewayLoginSource: login === "connection" ? "connection" : "own",
  };
}

export function gatewayLoginChoiceOf(config: unknown, credentialId: string | null | undefined): GatewayLoginChoice {
  if (readGatewayConfig(config).gatewayLoginSource === "connection") return "connection";
  return credentialId ? "saved" : "typed";
}

interface GatewayLoginFields {
  credentialId: string | null;
  username: string;
  password: string;
  domain: string;
}

/** The login columns to save: only what the chosen login uses, so no stale secret stays behind. */
export function gatewayLoginColumns(login: GatewayLoginChoice, fields: GatewayLoginFields) {
  if (login === "typed") {
    return {
      credential_id: null,
      username: fields.username.trim() || null,
      password: fields.password || null,
      domain: fields.domain.trim() || null,
    };
  }
  return { credential_id: login === "saved" ? fields.credentialId : null, username: null, password: null, domain: null };
}

/** Why a gateway entry cannot be saved, or null. */
export function gatewayEntryValidationError(
  config: Partial<RdGatewayConfig>,
  login: GatewayLoginChoice,
  credentialId: string | null,
): string | null {
  if (!config.gatewayHostname?.trim()) return "Enter a gateway server.";
  if (config.gatewayPort !== undefined && !validPort(config.gatewayPort)) {
    return "The gateway port must be a number from 1 to 65535.";
  }
  if (login === "saved" && !credentialId) {
    return "Pick a saved credential for the gateway login, or choose another login option.";
  }
  return null;
}

/** Turns what people paste ("gw:8443", a URL) into a host, moving a port into an empty Port field. */
export function splitGatewayHostInput(
  input: string,
  currentPort: number | undefined,
): Pick<RdGatewayConfig, "gatewayHostname" | "gatewayPort"> {
  const parsed = normalizeGatewayHost(input);
  return { gatewayHostname: parsed.hostname, gatewayPort: currentPort ?? parsed.port };
}

export interface GatewayOption {
  id: string;
  name: string;
  address: string;
}

type EntryLike = Pick<EntryMeta, "id" | "name" | "entry_type" | "credential_type" | "config">;

export function gatewayOptions(entries: readonly EntryLike[]): GatewayOption[] {
  return entries
    .filter(isRdGateway)
    .map((e) => ({ id: e.id, name: e.name, address: describeGatewayAddress(e.config) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function gatewayUsageCount(entries: readonly EntryLike[], gatewayId: string): number {
  return entries.filter((e) => e.entry_type === "rdp" && gatewayIdOf(e.config) === gatewayId).length;
}

/** "Used by 2 RDP entries". */
export function describeGatewayUsage(count: number): string {
  if (count === 0) return "No RDP entries use this gateway yet.";
  return `Used by ${count} RDP ${count === 1 ? "entry" : "entries"}.`;
}

export function gatewayDeleteMessage(name: string, usageCount: number): string {
  if (usageCount === 0) return `Are you sure you want to delete "${name}"?`;
  const users =
    usageCount === 1
      ? "1 RDP entry uses it. That entry will not connect until you pick another gateway for it."
      : `${usageCount} RDP entries use it. They will not connect until you pick another gateway for them.`;
  return `Delete the gateway "${name}"? ${users}`;
}

/** The RDP entry config to save: gatewayId when one is picked, and none of the old per-entry gateway keys. */
export function rdpGatewayConfigForSave(config: Partial<RdpEntryConfig>): Partial<RdpEntryConfig> {
  const result: Record<string, unknown> = { ...config };
  for (const key of LEGACY_RDP_GATEWAY_KEYS) delete result[key];
  const gatewayId = gatewayIdOf(config);
  if (gatewayId) result.gatewayId = gatewayId;
  else delete result.gatewayId;
  return result as Partial<RdpEntryConfig>;
}
