/**
 * Color scheme metadata for the settings UI. The CSS lives in src/styles/schemes.css; the preview
 * colors are the resolved tokens, which src/styles/__tests__/tokens-cascade.test.ts checks.
 */

export type SchemeId = "modern" | "ocean" | "ember" | "forest" | "amethyst" | "rose" | "midnight";

export interface SchemePreview {
  shell: string;
  editor: string;
  sidebar: string;
  accent: string;
}

export interface ColorScheme {
  id: SchemeId;
  label: string;
  preview: {
    dark: SchemePreview;
    light: SchemePreview;
  };
}

export const COLOR_SCHEMES: ReadonlyArray<ColorScheme> = [
  {
    id: "modern",
    label: "Modern",
    preview: {
      dark: { shell: "#191A1B", editor: "#121314", sidebar: "#191A1B", accent: "#0EA5E9" },
      light: { shell: "#FAFAFD", editor: "#FFFFFF", sidebar: "#FAFAFD", accent: "#0EA5E9" },
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    preview: {
      dark: { shell: "#1e293b", editor: "#0f172a", sidebar: "#1e293b", accent: "#0ea5e9" },
      light: { shell: "#f8fafc", editor: "#ffffff", sidebar: "#f8fafc", accent: "#0ea5e9" },
    },
  },
  {
    id: "ember",
    label: "Ember",
    preview: {
      dark: { shell: "#1a1210", editor: "#000000", sidebar: "#1a1210", accent: "#f97316" },
      light: { shell: "#fffbf5", editor: "#ffffff", sidebar: "#fffbf5", accent: "#f97316" },
    },
  },
  {
    id: "forest",
    label: "Forest",
    preview: {
      dark: { shell: "#12231a", editor: "#0a1510", sidebar: "#12231a", accent: "#10b981" },
      light: { shell: "#f2faf5", editor: "#ffffff", sidebar: "#f2faf5", accent: "#10b981" },
    },
  },
  {
    id: "amethyst",
    label: "Amethyst",
    preview: {
      dark: { shell: "#1a1430", editor: "#0e0a18", sidebar: "#1a1430", accent: "#8b5cf6" },
      light: { shell: "#f8f5ff", editor: "#ffffff", sidebar: "#f8f5ff", accent: "#8b5cf6" },
    },
  },
  {
    id: "rose",
    label: "Rose",
    preview: {
      dark: { shell: "#221418", editor: "#140a0c", sidebar: "#221418", accent: "#f43f5e" },
      light: { shell: "#fef5f6", editor: "#ffffff", sidebar: "#fef5f6", accent: "#f43f5e" },
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    preview: {
      dark: { shell: "#0a1418", editor: "#000000", sidebar: "#0a1418", accent: "#06b6d4" },
      light: { shell: "#f4fafc", editor: "#ffffff", sidebar: "#f4fafc", accent: "#06b6d4" },
    },
  },
];

export const DEFAULT_SCHEME: SchemeId = "modern";

const SCHEME_IDS: ReadonlySet<string> = new Set(COLOR_SCHEMES.map((scheme) => scheme.id));

export function isSchemeId(value: unknown): value is SchemeId {
  return typeof value === "string" && SCHEME_IDS.has(value);
}
