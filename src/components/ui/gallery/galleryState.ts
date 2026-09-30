/** Gallery appearance switches (spec 4.1). URL parameters make every combination addressable for screenshots. */
import { applyAppearanceAttributes, isIconPackId, isSchemeId, type ResolvedMode } from "../../../lib/appearance/dom";
import { DEFAULT_ICON_PACK, setIconPack, type IconPackId } from "../../../lib/icons";
import type { SchemeId } from "../../../lib/schemes";

export interface GalleryState {
  scheme: SchemeId;
  mode: ResolvedMode;
  pack: IconPackId;
  /** Show one section only (by id), for focused screenshots. */
  section: string | null;
}

const DEFAULTS: GalleryState = { scheme: "modern", mode: "dark", pack: DEFAULT_ICON_PACK, section: null };

export function readGalleryState(search: string): GalleryState {
  const params = new URLSearchParams(search);
  const scheme = params.get("scheme");
  const mode = params.get("mode");
  const pack = params.get("pack");
  return {
    scheme: isSchemeId(scheme) ? scheme : DEFAULTS.scheme,
    mode: mode === "light" || mode === "dark" ? mode : DEFAULTS.mode,
    pack: isIconPackId(pack) ? pack : DEFAULTS.pack,
    section: params.get("section"),
  };
}

export function gallerySearch(state: GalleryState): string {
  const params = new URLSearchParams({ scheme: state.scheme, mode: state.mode, pack: state.pack });
  if (state.section) params.set("section", state.section);
  return `?${params.toString()}`;
}

/** Applies the look to <html> the way useAppearance does, without touching the app's saved settings. */
export function applyGalleryState(state: GalleryState): Promise<void> {
  applyAppearanceAttributes(document.documentElement, { mode: state.mode, scheme: state.scheme });
  return setIconPack(state.pack);
}
