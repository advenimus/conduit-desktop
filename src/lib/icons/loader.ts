import { CODICONS_MAPPING, LAZY_ICON_PACKS, getPackMapping, loadPack } from "./pack-cache";
import { setIconPack } from "./store";
import {
  DEFAULT_ICON_PACK,
  ICON_PACK_STORAGE_KEY,
  PACK_BY_ICON_THEME,
  isIconPackId,
  isIconTheme,
  type IconMapping,
  type IconPackId,
  type IconTheme,
} from "./types";

export { getPackMapping };

/** Loads and caches a pack without making it active. */
export function loadIconPack(id: IconPackId): Promise<IconMapping>;
/**
 * @deprecated Platform themes are retired. Activates the pack the theme maps to
 * (default and ubuntu: tabler, macos: phosphor, windows: fluent) as before.
 */
export function loadIconPack(theme: IconTheme): Promise<IconMapping>;
export function loadIconPack(idOrTheme: IconPackId | IconTheme): Promise<IconMapping> {
  if (isIconTheme(idOrTheme)) {
    const id = PACK_BY_ICON_THEME[idOrTheme];
    return setIconPack(id).then(() => getPackMapping(id) ?? CODICONS_MAPPING);
  }
  return loadPack(idOrTheme);
}

/** Loads the five lazy packs, for previews that show every pack at once. Failures are logged. */
export async function preloadAllIconPacks(): Promise<void> {
  const results = await Promise.allSettled(LAZY_ICON_PACKS.map((id) => loadPack(id)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[icons] Could not preload the ${LAZY_ICON_PACKS[index]} icon pack`, result.reason);
    }
  });
}

function readStoredPack(): IconPackId {
  try {
    const stored = window.localStorage.getItem(ICON_PACK_STORAGE_KEY);
    return isIconPackId(stored) ? stored : DEFAULT_ICON_PACK;
  } catch (error) {
    console.warn("[icons] Could not read the saved icon pack", error);
    return DEFAULT_ICON_PACK;
  }
}

/**
 * Call before the first render. Codicons are bundled and apply at once; any
 * other saved pack loads lazily while Codicons show.
 */
export function bootIconPack(): Promise<void> {
  return setIconPack(readStoredPack());
}
