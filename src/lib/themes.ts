/**
 * Platform theme definitions for Conduit.
 *
 * Each platform theme controls chrome shape, icons, shadows, radii, font,
 * tab shape, and scrollbars. Color schemes layer orthogonally on top.
 *
 * The actual CSS token overrides live in src/themes/platform-*.css.
 * This file provides metadata for the settings UI and theme management.
 */

import type { ColorScheme } from "./schemes";

export type PlatformTheme = "default" | "macos" | "windows" | "ubuntu";

export interface PlatformThemeDefinition {
  id: PlatformTheme;
  label: string;
  subtitle: string;
  /** Platform-specific color schemes only shown when this theme is active */
  nativeSchemes: ColorScheme[];
  preview: {
    dark: { canvas: string; panel: string; accent: string };
    light: { canvas: string; panel: string; accent: string };
  };
}

export const PLATFORM_THEMES: PlatformThemeDefinition[] = [
  {
    id: "default",
    label: "Default",
    subtitle: "Conduit Classic",
    nativeSchemes: [],
    preview: {
      dark: { canvas: "#0f172a", panel: "#1e293b", accent: "#0ea5e9" },
      light: { canvas: "#f8fafc", panel: "#ffffff", accent: "#0ea5e9" },
    },
  },
  {
    id: "macos",
    label: "macOS Tahoe",
    subtitle: "Liquid Glass",
    nativeSchemes: [
      {
        id: "macos-blue",
        label: "System Blue",
        preview: {
          dark: { canvas: "#1c1c1e", panel: "#2c2c2e", accent: "#007AFF" },
          light: { canvas: "#f5f5f7", panel: "#ffffff", accent: "#007AFF" },
        },
      },
      {
        id: "macos-graphite",
        label: "Graphite",
        preview: {
          dark: { canvas: "#1c1c1e", panel: "#2c2c2e", accent: "#8E8E93" },
          light: { canvas: "#f5f5f7", panel: "#ffffff", accent: "#8E8E93" },
        },
      },
    ],
    preview: {
      dark: { canvas: "#1c1c1e", panel: "#2c2c2e", accent: "#007AFF" },
      light: { canvas: "#f5f5f7", panel: "#ffffff", accent: "#007AFF" },
    },
  },
  {
    id: "windows",
    label: "Windows 11",
    subtitle: "Fluent Design",
    nativeSchemes: [
      {
        id: "win-blue",
        label: "Windows Blue",
        preview: {
          dark: { canvas: "#202020", panel: "#2c2c2c", accent: "#0078D4" },
          light: { canvas: "#f3f3f3", panel: "#ffffff", accent: "#0078D4" },
        },
      },
      {
        id: "win-sun-valley",
        label: "Sun Valley",
        preview: {
          dark: { canvas: "#1a1a1a", panel: "#262626", accent: "#005FB8" },
          light: { canvas: "#f5f5f5", panel: "#ffffff", accent: "#005FB8" },
        },
      },
    ],
    preview: {
      dark: { canvas: "#202020", panel: "#2c2c2c", accent: "#0078D4" },
      light: { canvas: "#f3f3f3", panel: "#ffffff", accent: "#0078D4" },
    },
  },
  {
    id: "ubuntu",
    label: "Ubuntu",
    subtitle: "GNOME / Libadwaita",
    nativeSchemes: [
      {
        id: "ubuntu-yaru",
        label: "Yaru Orange",
        preview: {
          dark: { canvas: "#242424", panel: "#303030", accent: "#E95420" },
          light: { canvas: "#fafafa", panel: "#ffffff", accent: "#E95420" },
        },
      },
      {
        id: "ubuntu-gnome",
        label: "GNOME Blue",
        preview: {
          dark: { canvas: "#1e1e1e", panel: "#2a2a2a", accent: "#3584E4" },
          light: { canvas: "#fafafa", panel: "#ffffff", accent: "#3584E4" },
        },
      },
    ],
    preview: {
      dark: { canvas: "#242424", panel: "#303030", accent: "#E95420" },
      light: { canvas: "#fafafa", panel: "#ffffff", accent: "#E95420" },
    },
  },
];

export const DEFAULT_PLATFORM_THEME: PlatformTheme = "default";

/**
 * Get the full list of available color schemes for a given platform theme:
 * the platform's native schemes (if any) plus the universal schemes.
 */
export function getSchemesForPlatform(
  platformTheme: PlatformTheme,
  universalSchemes: ColorScheme[],
): { native: ColorScheme[]; universal: ColorScheme[] } {
  const def = PLATFORM_THEMES.find((t) => t.id === platformTheme);
  return {
    native: def?.nativeSchemes ?? [],
    universal: universalSchemes,
  };
}
