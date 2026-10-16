/**
 * Builds the text of a .rdp file for opening an entry in the system's RDP client.
 */

import { describeGatewayAddress, readGatewayConfig, type RdGatewayConfig } from './gateway-config.js';

const SOUND_MODES: Record<string, number> = { local: 0, remote: 1, none: 2 };

// .rdp files are line based, so a stray line break in a stored value would add settings.
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, '');
}

function gatewayLines(gateway: RdGatewayConfig | Record<string, unknown> | null | undefined): string[] {
  if (!gateway) return [];
  const address = describeGatewayAddress(gateway);
  if (!address) return [];
  const g = readGatewayConfig(gateway);
  return [
    `gatewayhostname:s:${oneLine(address)}`,
    // 1 = always use the gateway, 2 = skip it for local addresses
    `gatewayusagemethod:i:${g.gatewayBypassLocal ? 2 : 1}`,
    // 0 = ask for the gateway password
    'gatewaycredentialssource:i:0',
    'gatewayprofileusagemethod:i:1',
    // 1 = one login prompt for the gateway and the PC
    `promptcredentialonce:i:${g.gatewayLoginSource === 'connection' ? 1 : 0}`,
  ];
}

/** `gateway` is the config of the gateway entry the RDP entry points at, if any. */
export function buildRdpFileText(opts: {
  host: string;
  port: number;
  config: Record<string, unknown>;
  gateway?: RdGatewayConfig | Record<string, unknown> | null;
}): string {
  const { config } = opts;
  const lines = [
    `full address:s:${oneLine(opts.host)}:${opts.port}`,
    'prompt for credentials:i:1',
    'screen mode id:i:1',
  ];
  if (config.colorDepth) lines.push(`session bpp:i:${config.colorDepth}`);
  if (config.sound) lines.push(`audiomode:i:${SOUND_MODES[config.sound as string] ?? 0}`);
  if (typeof config.clipboard === 'boolean') {
    lines.push(`redirectclipboard:i:${config.clipboard ? 1 : 0}`);
  }
  lines.push(...gatewayLines(opts.gateway));
  return lines.join('\r\n') + '\r\n';
}
