/**
 * Popup context menu helper.
 *
 * Shows a styled context menu via a child BrowserWindow (separate OS window)
 * that renders above native WebContentsViews without needing to hide them.
 * The main process renders it (electron/ipc/menu.ts, spec 7.1).
 */

import { invoke } from "../lib/electron";
import { iconToSvg, SEMANTIC_ICON_NAMES, type SemanticIconName } from "../lib/icons";
import { resolveCssColor, type ColorToken } from "../lib/appearance/resolveCssColor";

/**
 * @deprecated Menu-local icon keys from before the icon registry (spec 5.7). Call sites may pass them
 * until R4-CLEANUP converts the rest to semantic names and removes this map. Each key keeps today's
 * distinction from its neighbors (Rename is not Edit, Copy Host is not Duplicate, Unfavorite is not
 * Favorite); null is an item that had no icon.
 */
export const LEGACY_MENU_ICON_KEYS = {
  play: "playerPlay",
  edit: "pencil",
  rename: "textCursor",
  "copy-host": "server",
  reconnect: "refresh",
  connect: "link",
  "folder-plus": "folderPlus",
  "external-link": "externalLink",
  dots: "ellipsis",
  "chevron-right": "chevronRight",
  "star-off": "starFilled",
  // Split Right and Split Down share this key; R2-TABS gives each its own glyph (spec 3.4).
  split: null,
} as const satisfies Readonly<Record<string, SemanticIconName | null>>;

export type LegacyMenuIconKey = keyof typeof LEGACY_MENU_ICON_KEYS;
export type MenuIconName = SemanticIconName | LegacyMenuIconKey;

export interface PopupMenuItem {
  id: string;
  label: string;
  type?: "separator" | "header";
  variant?: "danger";
  icon?: MenuIconName;
  children?: PopupMenuItem[]; // submenu items
}

/** The item shape the main process reads: the icon travels as markup it sanitizes. */
interface PopupMenuPayloadItem {
  id: string;
  label: string;
  type?: "separator" | "header";
  variant?: "danger";
  iconSvg?: string;
  children?: PopupMenuPayloadItem[];
}

const MENU_ICON_SIZE = 16;
const OVERLAY_TOKEN: ColorToken = "--c-overlay";

const MENU_COLOR_TOKENS = {
  overlay: OVERLAY_TOKEN,
  overlayBorder: "--c-overlay-border",
  inkSecondary: "--c-ink-secondary",
  inkMuted: "--c-ink-muted",
  selectionBg: "--c-menu-selection-bg",
  selectionBorder: "--c-menu-selection-border",
  danger: "--c-danger",
  dangerHover: "--c-menu-danger-hover-bg",
  divider: "--c-divider",
} as const satisfies Readonly<Record<string, ColorToken>>;

type MenuColorKey = keyof typeof MENU_COLOR_TOKENS;

const SEMANTIC_NAMES: ReadonlySet<string> = new Set(SEMANTIC_ICON_NAMES);

const isLegacyKey = (key: string): key is LegacyMenuIconKey => Object.prototype.hasOwnProperty.call(LEGACY_MENU_ICON_KEYS, key);

/** The semantic icon for a menu icon key (an old key or a semantic name), or null when it has none or is neither. */
export function menuIconName(key: string): SemanticIconName | null {
  if (isLegacyKey(key)) return LEGACY_MENU_ICON_KEYS[key];
  return SEMANTIC_NAMES.has(key) ? (key as SemanticIconName) : null;
}

function menuIconSvg(key: string): string | undefined {
  const name = menuIconName(key);
  if (!name && isLegacyKey(key)) return undefined;
  if (!name) {
    console.warn(`[contextMenu] Unknown menu icon "${key}"; the item is shown without one`);
    return undefined;
  }
  try {
    return iconToSvg(name, MENU_ICON_SIZE);
  } catch (err) {
    console.warn(`[contextMenu] Could not render the "${name}" icon; the item is shown without one`, err);
    return undefined;
  }
}

function toPayloadItem(item: PopupMenuItem): PopupMenuPayloadItem {
  const iconSvg = item.icon && !item.type ? menuIconSvg(item.icon) : undefined;
  return {
    id: item.id,
    label: item.label,
    ...(item.type ? { type: item.type } : {}),
    ...(item.variant ? { variant: item.variant } : {}),
    ...(iconSvg ? { iconSvg } : {}),
    ...(item.children?.length ? { children: item.children.map(toPayloadItem) } : {}),
  };
}

/**
 * The menu colors as #rrggbb, alpha flattened over the overlay. A token that does not resolve is left out
 * and the main process uses its built-in Modern value for it.
 */
function resolveMenuColors(): Partial<Record<MenuColorKey, string>> {
  const keys = Object.keys(MENU_COLOR_TOKENS) as MenuColorKey[];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const token = MENU_COLOR_TOKENS[key];
      try {
        return [[key, token === OVERLAY_TOKEN ? resolveCssColor(token) : resolveCssColor(token, OVERLAY_TOKEN)]];
      } catch (err) {
        console.warn(`[contextMenu] ${token} did not resolve; the menu uses its built-in color`, err);
        return [];
      }
    }),
  );
}

/**
 * Show a popup context menu at the given position and return the selected item id,
 * or null if dismissed.
 */
export async function showContextMenu(
  x: number,
  y: number,
  items: PopupMenuItem[],
  options?: { anchorRight?: boolean }
): Promise<string | null> {
  const theme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  document.dispatchEvent(
    new CustomEvent("conduit:popup-menu-change", { detail: { open: true } })
  );
  try {
    const payloadItems = items.map(toPayloadItem);
    const hasSubmenus = payloadItems.some((item) => item.children);
    return await invoke<string | null>("show_context_menu_popup", {
      items: payloadItems,
      x,
      y,
      theme,
      colors: resolveMenuColors(),
      ...(hasSubmenus ? { submenuIconSvg: menuIconSvg("chevronRight") } : {}),
      anchorRight: options?.anchorRight,
    });
  } catch (err) {
    console.error("[contextMenu] Could not show the popup menu:", err);
    return null;
  } finally {
    document.dispatchEvent(
      new CustomEvent("conduit:popup-menu-change", { detail: { open: false } })
    );
  }
}
