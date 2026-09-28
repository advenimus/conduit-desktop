import type { ComponentType, CSSProperties } from "react";

export const SEMANTIC_ICON_NAMES = [
  // ── Actions ──
  "close",
  "plus",
  "check",
  "search",
  "trash",
  "pencil",
  "copy",
  "refresh",
  "send",
  "download",
  "upload",
  "externalLink",
  "login",
  "logout",
  "restore",
  "settings",
  "eye",
  "eyeOff",

  // ── Navigation ──
  "home",
  "arrowLeft",
  "arrowRight",
  "arrowUp",
  "arrowsExchange",
  "chevronDown",
  "chevronLeft",
  "chevronRight",

  // ── Status ──
  "alertCircle",
  "alertTriangle",
  "infoCircle",
  "circleCheck",
  "circleX",
  "ban",
  "loader",
  "wifiOff",

  // ── Security ──
  "lock",
  "lockOpen",
  "key",
  "shield",
  "shieldCheck",
  "shieldLock",
  "fingerprint",

  // ── Files & Folders ──
  "file",
  "fileCode",
  "fileImport",
  "filePlus",
  "fileText",
  "fileX",
  "folder",
  "folderOpen",
  "folderPlus",

  // ── People ──
  "user",
  "users",
  "crown",

  // ── Connection types ──
  "terminal",
  "terminalAlt",
  "desktop",
  "globe",
  "globeWww",
  "server",
  "serverAlt",
  "devices",
  "network",
  "plug",
  "plugDisconnected",

  // ── Favorites ──
  "star",
  "starFilled",
  "pin",
  "pinFilled",

  // ── Data ──
  "database",
  "history",
  "calendar",
  "clock",
  "tag",
  "notes",

  // ── Communication ──
  "mail",
  "message",
  "messageChatbot",

  // ── Cloud ──
  "cloud",
  "cloudOff",
  "cloudDownload",

  // ── AI / Automation ──
  "robot",
  "sparkles",
  "tool",
  "stack",
  "bolt",
  "rocket",

  // ── Media / Controls ──
  "playerPlay",
  "playerStop",
  "playerStopFilled",
  "playerSkipForward",

  // ── Input ──
  "keyboard",
  "qrcode",
  "target",

  // ── Appearance ──
  "palette",
  "icons",
  "photo",

  // ── Devices ──
  "deviceMobile",

  // ── Misc ──
  "hammer",
  "bug",
  "floppy",

  // ── Markdown toolbar ──
  "bold",
  "italic",
  "strikethrough",
  "heading1",
  "heading2",
  "link",
  "code",
  "list",
  "listNumbers",
  "table",
  "quote",

  // ── Layout and chrome ──
  "menu",
  "panelLeft",
  "panelLeftOff",
  "panelRight",
  "panelRightOff",
  "splitHorizontal",
  "splitVertical",
  "ellipsis",
  "collapseAll",
  "account",
  "explorer",
  "circleFilled",
] as const;

export type SemanticIconName = (typeof SEMANTIC_ICON_NAMES)[number];

export const DEFAULT_ICON_SIZE = 16;

/** Props accepted by all themed icon components. */
export interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Use the pack's 12px glyph where one exists (Codicons). */
  compact?: boolean;
  /** Makes the icon an image with this accessible name; icons are decorative otherwise. */
  title?: string;
  /** Line width for Lucide and Tabler; the fill-based packs ignore it. */
  stroke?: number;
}

/** A React component that renders an icon with the standard IconProps API. */
export type IconComponent = ComponentType<IconProps>;

/** A complete mapping from every semantic name to an icon component. */
export type IconMapping = Readonly<Record<SemanticIconName, IconComponent>>;

export type IconPackId = "codicons" | "lucide" | "tabler" | "phosphor" | "fluent" | "material";

export interface IconPackInfo {
  id: IconPackId;
  label: string;
  description: string;
  license: string;
  packageName: string;
  version: string;
}

export const DEFAULT_ICON_PACK: IconPackId = "codicons";

export const ICON_PACK_STORAGE_KEY = "conduit-icon-pack";

export const ICON_PACKS: ReadonlyArray<IconPackInfo> = Object.freeze([
  {
    id: "codicons",
    label: "Codicons",
    description: "VS Code icons · CC BY 4.0",
    license: "CC-BY-4.0",
    packageName: "@iconify-json/codicon",
    version: "1.2.73",
  },
  {
    id: "lucide",
    label: "Lucide",
    description: "Clean line icons · ISC",
    license: "ISC",
    packageName: "lucide-react",
    version: "1.48.0",
  },
  {
    id: "tabler",
    label: "Tabler (Classic)",
    description: "The classic Conduit icons · MIT",
    license: "MIT",
    packageName: "@tabler/icons-react",
    version: "3.38.0",
  },
  {
    id: "phosphor",
    label: "Phosphor",
    description: "Soft, rounded icons · MIT",
    license: "MIT",
    packageName: "@phosphor-icons/react",
    version: "2.1.10",
  },
  {
    id: "fluent",
    label: "Fluent",
    description: "Windows 11 icons · MIT",
    license: "MIT",
    packageName: "@fluentui/react-icons",
    version: "2.0.321",
  },
  {
    id: "material",
    label: "Material Symbols",
    description: "Google Material icons · Apache 2.0",
    license: "Apache-2.0",
    packageName: "@iconify-json/material-symbols-light",
    version: "1.2.94",
  },
] as const satisfies ReadonlyArray<IconPackInfo>);

const PACK_IDS: ReadonlySet<string> = new Set(ICON_PACKS.map((pack) => pack.id));

export function isIconPackId(value: unknown): value is IconPackId {
  return typeof value === "string" && PACK_IDS.has(value);
}

/** @deprecated Platform themes are retired; use IconPackId. Removed by W4-CLEANUP. */
export type IconTheme = "default" | "macos" | "windows" | "ubuntu";

/** @deprecated Retired with the platform themes. */
export interface ThemeIconDefaults {
  size: number;
  strokeWidth: number;
}

/** @deprecated Retired with the platform themes. */
export const THEME_ICON_DEFAULTS: Readonly<Record<IconTheme, ThemeIconDefaults>> = Object.freeze({
  default: { size: 16, strokeWidth: 1.5 },
  macos: { size: 16, strokeWidth: 1.5 },
  windows: { size: 16, strokeWidth: 1.5 },
  ubuntu: { size: 16, strokeWidth: 2.0 },
});

/** @deprecated Maps a retired platform theme to the pack its users keep (spec 5.9). */
export const PACK_BY_ICON_THEME: Readonly<Record<IconTheme, IconPackId>> = Object.freeze({
  default: "tabler",
  macos: "phosphor",
  windows: "fluent",
  ubuntu: "tabler",
});

const ICON_THEMES: ReadonlySet<string> = new Set(Object.keys(PACK_BY_ICON_THEME));

export function isIconTheme(value: unknown): value is IconTheme {
  return typeof value === "string" && ICON_THEMES.has(value);
}
