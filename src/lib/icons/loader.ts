/**
 * Lazy loader for icon packs.
 * Only the default (Tabler) pack is statically bundled.
 * Other packs are loaded on demand when the platform theme changes.
 */

import type { IconTheme, IconMapping } from "./types";
import { mapping as defaultMapping } from "./packs/default";
import { useIconThemeStore } from "./theme-store";

const cache = new Map<IconTheme, IconMapping>();
cache.set("default", defaultMapping);

/**
 * Load the icon pack for the given platform theme.
 * Returns immediately if already cached; otherwise loads asynchronously
 * and updates the Zustand store when ready.
 */
export async function loadIconPack(theme: IconTheme): Promise<IconMapping> {
  const cached = cache.get(theme);
  if (cached) {
    useIconThemeStore.getState().setMapping(cached);
    return cached;
  }

  let pack: IconMapping;

  switch (theme) {
    case "macos": {
      const mod = await import("./packs/macos");
      pack = mod.mapping;
      break;
    }
    case "windows": {
      const mod = await import("./packs/windows");
      pack = mod.mapping;
      break;
    }
    case "ubuntu": {
      const mod = await import("./packs/ubuntu");
      pack = mod.mapping;
      break;
    }
    default:
      pack = defaultMapping;
  }

  cache.set(theme, pack);
  useIconThemeStore.getState().setMapping(pack);
  return pack;
}
