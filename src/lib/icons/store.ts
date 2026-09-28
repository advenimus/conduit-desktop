import { create } from "zustand";
import { CODICONS_MAPPING, getPackMapping, loadPack, loadedPackIds, onPackLoaded } from "./pack-cache";
import {
  DEFAULT_ICON_PACK,
  ICON_PACK_STORAGE_KEY,
  PACK_BY_ICON_THEME,
  isIconPackId,
  type IconMapping,
  type IconPackId,
  type IconTheme,
} from "./types";

export type IconPackStatus = "ready" | "loading" | "error";

export interface IconPackState {
  /** The pack whose mapping is rendered. */
  pack: IconPackId;
  mapping: IconMapping;
  /** "loading" while `requested` differs from `pack`; "error" when that load failed. */
  status: IconPackStatus;
  requested: IconPackId;
  error: string | null;
  loaded: ReadonlyArray<IconPackId>;
  setIconPack: (id: IconPackId) => Promise<void>;
  /** @deprecated Maps a retired platform theme to its pack. Removed by W4-CLEANUP. */
  setTheme: (theme: IconTheme) => void;
}

let latestRequest = 0;

export const useIconPackStore = create<IconPackState>()(() => ({
  pack: DEFAULT_ICON_PACK,
  mapping: CODICONS_MAPPING,
  status: "ready",
  requested: DEFAULT_ICON_PACK,
  error: null,
  loaded: loadedPackIds(),
  setIconPack: (id) => requestIconPack(id),
  setTheme: (theme) => {
    void requestIconPack(PACK_BY_ICON_THEME[theme] ?? DEFAULT_ICON_PACK);
  },
}));

/** @deprecated Use useIconPackStore. Removed by W4-CLEANUP. */
export const useIconThemeStore = useIconPackStore;

/**
 * Switches the active pack. Loads lazily and never rejects: a load that finishes
 * after a newer request is dropped, and a failed load keeps the current pack.
 */
async function requestIconPack(id: IconPackId): Promise<void> {
  const request = ++latestRequest;
  const cached = getPackMapping(id);
  if (cached) {
    useIconPackStore.setState({ pack: id, mapping: cached, requested: id, status: "ready", error: null });
    return;
  }

  useIconPackStore.setState({ requested: id, status: "loading", error: null });
  try {
    const mapping = await loadPack(id);
    if (request !== latestRequest) return;
    useIconPackStore.setState({ pack: id, mapping, status: "ready", error: null });
  } catch (error) {
    console.error(`[icons] Could not load the ${id} icon pack`, error);
    if (request !== latestRequest) return;
    const message = error instanceof Error ? error.message : String(error);
    useIconPackStore.setState({ status: "error", error: message });
  }
}

export function setIconPack(id: IconPackId): Promise<void> {
  return useIconPackStore.getState().setIconPack(id);
}

onPackLoaded(() => useIconPackStore.setState({ loaded: loadedPackIds() }));

function handleThemeChange(event: Event): void {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "object" || detail === null) return;
  const { iconPack } = detail as { iconPack?: unknown };
  if (isIconPackId(iconPack)) void setIconPack(iconPack);
}

// Other windows (overlay, picker) follow the main window through localStorage.
function handleStorage(event: StorageEvent): void {
  if (event.key !== ICON_PACK_STORAGE_KEY) return;
  void setIconPack(isIconPackId(event.newValue) ? event.newValue : DEFAULT_ICON_PACK);
}

if (typeof document !== "undefined") document.addEventListener("conduit:theme-change", handleThemeChange);
if (typeof window !== "undefined") window.addEventListener("storage", handleStorage);
