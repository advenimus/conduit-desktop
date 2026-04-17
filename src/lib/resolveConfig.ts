/**
 * Three-layer config resolution: hardcoded → global settings → per-entry overrides.
 *
 * Per-entry configs store only explicitly-set fields. Undefined fields fall through
 * to the global defaults from Settings, which in turn fall through to hardcoded defaults.
 */

import type {
  RdpEntryConfig,
  WebEntryConfig,
  RdpGlobalDefaults,
  WebGlobalDefaults,
  TerminalGlobalDefaults,
  SshGlobalDefaults,
  SshAuthMethod,
} from "../types/entry";
import {
  HARDCODED_RDP_DEFAULTS,
  HARDCODED_WEB_DEFAULTS,
  HARDCODED_TERMINAL_DEFAULTS,
  HARDCODED_SSH_DEFAULTS,
} from "../types/entry";

export function resolveRdpConfig(
  entryConfig: Partial<RdpEntryConfig>,
  globalDefaults: RdpGlobalDefaults,
): RdpEntryConfig {
  return {
    resolution: entryConfig.resolution ?? globalDefaults.resolution,
    customWidth: entryConfig.customWidth,
    customHeight: entryConfig.customHeight,
    colorDepth: entryConfig.colorDepth ?? globalDefaults.colorDepth,
    sound: entryConfig.sound ?? globalDefaults.sound,
    quality: entryConfig.quality ?? globalDefaults.quality,
    clipboard: entryConfig.clipboard ?? globalDefaults.clipboard,
    enableNla: entryConfig.enableNla ?? globalDefaults.enableNla,
    hostname: entryConfig.hostname,
    sharedFolders: entryConfig.sharedFolders ?? [],
    enableHighDpi: entryConfig.enableHighDpi ?? globalDefaults.enableHighDpi,
  };
}

export function resolveWebConfig(
  entryConfig: Partial<WebEntryConfig>,
  globalDefaults: WebGlobalDefaults,
): WebEntryConfig {
  return {
    ignoreCertErrors: entryConfig.ignoreCertErrors ?? globalDefaults.ignoreCertErrors,
    engine: entryConfig.engine ?? globalDefaults.engine,
    autofill: entryConfig.autofill,
  };
}

export function resolveTerminalConfig(
  globalDefaults: TerminalGlobalDefaults,
): TerminalGlobalDefaults {
  return { ...globalDefaults };
}

/** Resolve global defaults with hardcoded fallbacks */
export function resolveGlobalRdp(settings: Partial<RdpGlobalDefaults> | undefined): RdpGlobalDefaults {
  return { ...HARDCODED_RDP_DEFAULTS, ...settings };
}

export function resolveGlobalWeb(settings: Partial<WebGlobalDefaults> | undefined): WebGlobalDefaults {
  return { ...HARDCODED_WEB_DEFAULTS, ...settings };
}

export function resolveGlobalTerminal(settings: Partial<TerminalGlobalDefaults> | undefined): TerminalGlobalDefaults {
  return { ...HARDCODED_TERMINAL_DEFAULTS, ...settings };
}

export function resolveGlobalSsh(settings: Partial<SshGlobalDefaults> | undefined): SshGlobalDefaults {
  return { ...HARDCODED_SSH_DEFAULTS, ...settings };
}

/**
 * Resolve SSH auth method: per-entry override → credential preference → global default → 'key'.
 */
export function resolveSshAuthMethod(
  entryConfigMethod: string | null | undefined,
  credentialMethod: string | null | undefined,
  globalDefaults: SshGlobalDefaults,
): SshAuthMethod {
  const method = entryConfigMethod ?? credentialMethod ?? globalDefaults.authMethodWhenKeyPresent;
  return method === 'password' ? 'password' : 'key';
}
