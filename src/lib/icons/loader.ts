import { LAZY_ICON_PACKS, getPackMapping, loadPack } from "./pack-cache";
import { setIconPack } from "./store";
import { DEFAULT_ICON_PACK, ICON_PACK_STORAGE_KEY, isIconPackId, type IconMapping, type IconPackId } from "./types";

export { getPackMapping };

/** Loads and caches a pack without making it active. */
export function loadIconPack(id: IconPackId): Promise<IconMapping> {
  return loadPack(id);
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
 * Call before the first render. Lucide is bundled and applies at once; any
 * other saved pack loads lazily while Lucide shows.
 */
export function bootIconPack(): Promise<void> {
  return setIconPack(readStoredPack());
}
