/**
 * Lightweight Zustand store that caches session-default settings in the renderer.
 * Avoids an extra IPC call per connection — loads once on app start and refreshes after saves.
 */

import { create } from "zustand";
import { invoke } from "../lib/electron";
import type {
  RdpGlobalDefaults,
  WebGlobalDefaults,
  TerminalGlobalDefaults,
  SshGlobalDefaults,
} from "../types/entry";
import {
  HARDCODED_RDP_DEFAULTS,
  HARDCODED_WEB_DEFAULTS,
  HARDCODED_TERMINAL_DEFAULTS,
  HARDCODED_SSH_DEFAULTS,
} from "../types/entry";

interface SettingsState {
  sessionDefaultsRdp: RdpGlobalDefaults;
  sessionDefaultsWeb: WebGlobalDefaults;
  sessionDefaultsTerminal: TerminalGlobalDefaults;
  sessionDefaultsSsh: SshGlobalDefaults;
  loaded: boolean;
  refresh: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  sessionDefaultsRdp: { ...HARDCODED_RDP_DEFAULTS },
  sessionDefaultsWeb: { ...HARDCODED_WEB_DEFAULTS },
  sessionDefaultsTerminal: { ...HARDCODED_TERMINAL_DEFAULTS },
  sessionDefaultsSsh: { ...HARDCODED_SSH_DEFAULTS },
  loaded: false,

  refresh: async () => {
    try {
      const settings = await invoke<Record<string, unknown>>("settings_get");
      set({
        sessionDefaultsRdp: {
          ...HARDCODED_RDP_DEFAULTS,
          ...(settings.session_defaults_rdp as Partial<RdpGlobalDefaults> | undefined),
        },
        sessionDefaultsWeb: {
          ...HARDCODED_WEB_DEFAULTS,
          ...(settings.session_defaults_web as Partial<WebGlobalDefaults> | undefined),
        },
        sessionDefaultsTerminal: {
          ...HARDCODED_TERMINAL_DEFAULTS,
          ...(settings.session_defaults_terminal as Partial<TerminalGlobalDefaults> | undefined),
        },
        sessionDefaultsSsh: {
          ...HARDCODED_SSH_DEFAULTS,
          ...(settings.session_defaults_ssh as Partial<SshGlobalDefaults> | undefined),
        },
        loaded: true,
      });
    } catch (err) {
      console.error("Failed to load session defaults:", err);
    }
  },
}));

// Auto-load on import
useSettingsStore.getState().refresh();
