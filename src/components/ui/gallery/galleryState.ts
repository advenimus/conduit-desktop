/** Gallery appearance switches (spec 4.1). URL parameters make every combination addressable for screenshots. */
import { applyAppearanceAttributes, isDensity, isIconPackId, isSchemeId, type ResolvedMode } from "../../../lib/appearance/dom";
import { setIconPack, type IconPackId } from "../../../lib/icons";
import type { SchemeId } from "../../../lib/schemes";
import type { Density } from "../../../styles/metrics";

export interface GalleryState {
  scheme: SchemeId;
  mode: ResolvedMode;
  density: Density;
  pack: IconPackId;
  /** Show one section only (by id), for focused screenshots. */
  section: string | null;
}

const DEFAULTS: GalleryState = { scheme: "modern", mode: "dark", density: "comfortable", pack: "codicons", section: null };

export function readGalleryState(search: string): GalleryState {
  const params = new URLSearchParams(search);
  const scheme = params.get("scheme");
  const mode = params.get("mode");
  const density = params.get("density");
  const pack = params.get("pack");
  return {
    scheme: isSchemeId(scheme) ? scheme : DEFAULTS.scheme,
    mode: mode === "light" || mode === "dark" ? mode : DEFAULTS.mode,
    density: isDensity(density) ? density : DEFAULTS.density,
    pack: isIconPackId(pack) ? pack : DEFAULTS.pack,
    section: params.get("section"),
  };
}

export function gallerySearch(state: GalleryState): string {
  const params = new URLSearchParams({ scheme: state.scheme, mode: state.mode, density: state.density, pack: state.pack });
  if (state.section) params.set("section", state.section);
  return `?${params.toString()}`;
}

/** Applies the look to <html> the way useAppearance does, without touching the app's saved settings. */
export function applyGalleryState(state: GalleryState): Promise<void> {
  applyAppearanceAttributes(document.documentElement, { mode: state.mode, scheme: state.scheme, density: state.density });
  return setIconPack(state.pack);
}
