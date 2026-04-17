/**
 * Color scheme definitions for Conduit.
 *
 * Each scheme defines a unique accent color and surface tones for both
 * light and dark modes. The actual CSS variables are in src/index.css;
 * this file provides metadata for the settings UI preview cards.
 */

export interface ColorScheme {
  id: string;
  label: string;
  preview: {
    dark: { canvas: string; panel: string; accent: string };
    light: { canvas: string; panel: string; accent: string };
  };
}

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    id: "ocean",
    label: "Ocean",
    preview: {
      dark: { canvas: "#0f172a", panel: "#1e293b", accent: "#0ea5e9" },
      light: { canvas: "#f8fafc", panel: "#ffffff", accent: "#0ea5e9" },
    },
  },
  {
    id: "ember",
    label: "Ember",
    preview: {
      dark: { canvas: "#000000", panel: "#1a1210", accent: "#f97316" },
      light: { canvas: "#fffbf5", panel: "#ffffff", accent: "#f97316" },
    },
  },
  {
    id: "forest",
    label: "Forest",
    preview: {
      dark: { canvas: "#0a1510", panel: "#12231a", accent: "#10b981" },
      light: { canvas: "#f2faf5", panel: "#ffffff", accent: "#10b981" },
    },
  },
  {
    id: "amethyst",
    label: "Amethyst",
    preview: {
      dark: { canvas: "#0e0a18", panel: "#1a1430", accent: "#8b5cf6" },
      light: { canvas: "#f8f5ff", panel: "#ffffff", accent: "#8b5cf6" },
    },
  },
  {
    id: "rose",
    label: "Rose",
    preview: {
      dark: { canvas: "#140a0c", panel: "#221418", accent: "#f43f5e" },
      light: { canvas: "#fef5f6", panel: "#ffffff", accent: "#f43f5e" },
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    preview: {
      dark: { canvas: "#000000", panel: "#0a1418", accent: "#06b6d4" },
      light: { canvas: "#f4fafc", panel: "#ffffff", accent: "#06b6d4" },
    },
  },
];

export const DEFAULT_SCHEME = "ocean";
