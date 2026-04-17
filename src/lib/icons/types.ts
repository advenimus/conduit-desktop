/**
 * Semantic icon type system for the multi-platform theme engine.
 *
 * Each platform theme maps these semantic names to its own icon library:
 *   - default  → @tabler/icons-react
 *   - macos    → @phosphor-icons/react
 *   - windows  → @fluentui/react-icons
 *   - ubuntu   → @tabler/icons-react (bold stroke)
 */

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
] as const;

export type SemanticIconName = (typeof SEMANTIC_ICON_NAMES)[number];

/** Props accepted by all themed icon components. */
export interface IconProps {
  size?: number;
  stroke?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** A React component that renders an icon with the standard IconProps API. */
export type IconComponent = React.ComponentType<IconProps>;

/** A complete mapping from every semantic name to an icon component. */
export type IconMapping = Record<SemanticIconName, IconComponent>;

export type IconTheme = "default" | "macos" | "windows" | "ubuntu";

/** Default icon rendering props per platform theme. */
export interface ThemeIconDefaults {
  size: number;
  strokeWidth: number;
}

export const THEME_ICON_DEFAULTS: Record<IconTheme, ThemeIconDefaults> = {
  default: { size: 16, strokeWidth: 1.5 },
  macos: { size: 16, strokeWidth: 1.5 },
  windows: { size: 16, strokeWidth: 1.5 },
  ubuntu: { size: 16, strokeWidth: 2.0 },
};
