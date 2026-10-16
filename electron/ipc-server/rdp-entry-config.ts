/**
 * Pure translation from a saved RDP entry's stored `config` JSON blob to an
 * RdpEngineConfig usable by the RDP manager.
 *
 * Kept free of any Electron / service imports (type-only imports are erased at
 * compile time) so it can be unit-tested in isolation. The renderer performs
 * the equivalent translation in `src/stores/entryStore.ts`; this is the
 * headless counterpart used when an MCP/AI agent opens a saved entry.
 */

import type { RdpEngineConfig } from '../services/rdp/engine.js';
import {
  HARDCODED_GATEWAY_DEFAULTS,
  resolveGatewaySettings,
  type RdpEntryGatewayFields,
  type RdpGatewayDefaults,
} from '../services/rdp/gateway-config.js';
import { connectGateway, type CredentialLookup } from '../services/rdp/gateway-connect.js';

/** Minimal view of the RDP fields stored on an entry's `config` JSON blob. */
export interface RdpEntryConfigFields extends RdpEntryGatewayFields {
  resolution?: string;
  customWidth?: number;
  customHeight?: number;
  colorDepth?: 32 | 24 | 16 | 15;
  quality?: 'best' | 'good' | 'low';
  clipboard?: boolean;
  enableNla?: boolean;
  hostname?: string;
  sharedFolders?: { name: string; path: string; readOnly?: boolean }[];
}

/** Map the entry's quality setting to the engine's performance mode (mirrors the renderer). */
export function mapQualityToPerformanceMode(
  quality: 'best' | 'good' | 'low' | undefined,
): 'best' | 'balanced' | 'fast' {
  switch (quality) {
    case 'best':
      return 'best';
    case 'low':
      return 'fast';
    case 'good':
    default:
      return 'balanced';
  }
}

/**
 * Resolve a stored resolution string to fixed pixel dimensions.
 *
 * "match_window" can't be honored headlessly (no DOM/devicePixelRatio), so it
 * falls back to 1920x1080 — the same default the manual connection_open uses.
 */
export function resolutionToDimensions(cfg: RdpEntryConfigFields): { width: number; height: number } {
  const res = cfg.resolution;
  if (res === 'custom') {
    return { width: cfg.customWidth ?? 1920, height: cfg.customHeight ?? 1080 };
  }
  if (res && res.includes('x')) {
    const [w, h] = res.split('x').map((n) => Number(n));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  }
  // "match_window" or unset → sane fixed default
  return { width: 1920, height: 1080 };
}

/**
 * Build an RdpEngineConfig from a saved entry's stored config, honoring the
 * fields the entry persists (resolution, NLA, color depth, quality, clipboard,
 * shared folders). Fields that depend on a live window (DPI scale factors) are
 * left unset, matching the manual tool.
 *
 * The gateway resolves like the renderer's: entry fields over the device's
 * RDP defaults, with a linked gateway login read through `lookupCredential`.
 * Throws GatewayConfigError when the gateway has no usable login.
 */
export function buildRdpEngineConfigFromEntry(opts: {
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  entryConfig: Record<string, unknown> | undefined;
  gatewayDefaults?: RdpGatewayDefaults;
  lookupCredential?: CredentialLookup;
}): RdpEngineConfig {
  const cfg = (opts.entryConfig ?? {}) as RdpEntryConfigFields;
  const { width, height } = resolutionToDimensions(cfg);
  const gateway = connectGateway(
    resolveGatewaySettings(cfg, opts.gatewayDefaults ?? HARDCODED_GATEWAY_DEFAULTS),
    { username: opts.username, password: opts.password, domain: opts.domain },
    opts.lookupCredential ?? (() => null),
  );

  return {
    host: opts.host,
    hostname: cfg.hostname,
    port: opts.port,
    username: opts.username,
    password: opts.password,
    domain: opts.domain,
    width,
    height,
    enableNla: cfg.enableNla ?? true,
    skipCertVerification: true,
    colorDepth: cfg.colorDepth,
    performanceMode: mapQualityToPerformanceMode(cfg.quality),
    sharedFolders: cfg.sharedFolders?.length ? cfg.sharedFolders : undefined,
    enableBitmapCache: true,
    enableServerPointer: true,
    frameRate: 30,
    enableClipboard: cfg.clipboard ?? true,
    gateway,
  };
}
