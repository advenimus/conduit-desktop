/**
 * Builds the text of a .rdp file for opening an entry in the system's RDP client.
 */

import {
  RDP_GATEWAY_DEFAULT_PORT,
  resolveGatewaySettings,
  type RdpEntryGatewayFields,
  type RdpGatewayDefaults,
} from './gateway-config.js';

const SOUND_MODES: Record<string, number> = { local: 0, remote: 1, none: 2 };

// .rdp files are line based, so a stray line break in a stored value would add settings.
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, '');
}

function gatewayLines(config: Record<string, unknown>, defaults: RdpGatewayDefaults): string[] {
  const gw = resolveGatewaySettings(config as RdpEntryGatewayFields, defaults);
  if (!gw) return [];
  const address = gw.port === RDP_GATEWAY_DEFAULT_PORT ? gw.hostname : `${gw.hostname}:${gw.port}`;
  return [
    `gatewayhostname:s:${oneLine(address)}`,
    // 1 = always use the gateway, 2 = skip it for local addresses
    `gatewayusagemethod:i:${gw.bypassLocal ? 2 : 1}`,
    // 0 = ask for the gateway password
    'gatewaycredentialssource:i:0',
    'gatewayprofileusagemethod:i:1',
    'promptcredentialonce:i:1',
  ];
}

export function buildRdpFileText(opts: {
  host: string;
  port: number;
  config: Record<string, unknown>;
  gatewayDefaults: RdpGatewayDefaults;
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
  lines.push(...gatewayLines(config, opts.gatewayDefaults));
  return lines.join('\r\n') + '\r\n';
}
