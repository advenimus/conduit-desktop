/**
 * Shared option arrays for session settings.
 * Used by both Settings dialog (global defaults) and Entry dialog (per-entry overrides).
 */

import type { RdpResolution, RdpGlobalResolution } from "../types/entry";

export const RESOLUTION_OPTIONS: { value: RdpResolution; label: string }[] = [
  { value: "match_window", label: "Match Window" },
  { value: "1920x1080", label: "1920 x 1080" },
  { value: "1280x720", label: "1280 x 720" },
  { value: "1440x900", label: "1440 x 900" },
  { value: "custom", label: "Custom" },
];

/** Resolution options for global defaults (excludes "Custom" — that's per-entry only) */
export const GLOBAL_RESOLUTION_OPTIONS: { value: RdpGlobalResolution; label: string }[] = [
  { value: "match_window", label: "Match Window" },
  { value: "1920x1080", label: "1920 x 1080" },
  { value: "1280x720", label: "1280 x 720" },
  { value: "1440x900", label: "1440 x 900" },
];

export const COLOR_DEPTH_OPTIONS: { value: number; label: string }[] = [
  { value: 32, label: "32-bit (True Color)" },
  { value: 24, label: "24-bit" },
  { value: 16, label: "16-bit (High Color)" },
  { value: 15, label: "15-bit" },
];

export const QUALITY_OPTIONS: { value: string; label: string }[] = [
  { value: "best", label: "Best" },
  { value: "good", label: "Good" },
  { value: "low", label: "Low" },
];

export const SOUND_OPTIONS: { value: string; label: string }[] = [
  { value: "local", label: "Play locally" },
  { value: "remote", label: "Play on remote" },
  { value: "none", label: "Disabled" },
];

export const WEB_ENGINE_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto (uses Edge on Windows when available)" },
  { value: "chromium", label: "Chromium (built-in)" },
  { value: "webview2", label: "Edge / WebView2 (Windows SSO)" },
];
