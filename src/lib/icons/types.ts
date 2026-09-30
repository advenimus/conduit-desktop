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
  "splitHorizontal",
  "splitVertical",
  "ellipsis",
  "circleFilled",

  // ── Editing ──
  "textCursor",
] as const;

export type SemanticIconName = (typeof SEMANTIC_ICON_NAMES)[number];

export const DEFAULT_ICON_SIZE = 16;

/** Props accepted by all themed icon components. */
export interface IconProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Use the glyph's 12px variant where one exists (the state dot). */
  compact?: boolean;
  /** Makes the icon an image with this accessible name; icons are decorative otherwise. */
  title?: string;
  /** Line width for Lucide, Tabler and Hugeicons; the fill-based packs ignore it. */
  stroke?: number;
}

/** A React component that renders an icon with the standard IconProps API. */
export type IconComponent = ComponentType<IconProps>;

/** A complete mapping from every semantic name to an icon component. */
export type IconMapping = Readonly<Record<SemanticIconName, IconComponent>>;

export type IconPackId = "lucide" | "phosphor" | "hugeicons" | "material" | "fluent" | "tabler";

export interface IconPackInfo {
  id: IconPackId;
  label: string;
  description: string;
  license: string;
  packageName: string;
  version: string;
}

export const DEFAULT_ICON_PACK: IconPackId = "lucide";

export const ICON_PACK_STORAGE_KEY = "conduit-icon-pack";

/** Every shipped pack, in the order the Settings picker shows them (spec 5.8). */
export const ICON_PACKS: ReadonlyArray<IconPackInfo> = Object.freeze([
  {
    id: "lucide",
    label: "Lucide",
    description: "Clean line icons · ISC",
    license: "ISC",
    packageName: "lucide-react",
    version: "1.48.0",
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
    id: "hugeicons",
    label: "Hugeicons",
    description: "Rounded line icons · MIT",
    license: "MIT",
    packageName: "@hugeicons/core-free-icons",
    version: "4.3.5",
  },
  {
    id: "material",
    label: "Material Symbols",
    description: "Google Material icons · Apache 2.0",
    license: "Apache-2.0",
    packageName: "@iconify-json/material-symbols-light",
    version: "1.2.94",
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
    id: "tabler",
    label: "Tabler (Classic)",
    description: "The classic Conduit icons · MIT",
    license: "MIT",
    packageName: "@tabler/icons-react",
    version: "3.38.0",
  },
] as const satisfies ReadonlyArray<IconPackInfo>);

const PACK_IDS: ReadonlySet<string> = new Set(ICON_PACKS.map((pack) => pack.id));

export function isIconPackId(value: unknown): value is IconPackId {
  return typeof value === "string" && PACK_IDS.has(value);
}
