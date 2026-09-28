import { materialGlyphs } from "../generated/material";
import { createGlyphIcons } from "../glyph";
import type { IconMapping } from "../types";
import { createStateDotIcon } from "./state-dot";

/**
 * Material Symbols keep a 2px padding on their 24px grid and drew about a third smaller than the other packs.
 * 1.35 is the widest trim that clips no mapped glyph (wifiOff reaches x 1.41 and 22.61); the registry test
 * checks every glyph against it.
 */
export const MATERIAL_TRIM = 1.35;

export const mapping: IconMapping = {
  ...createGlyphIcons(materialGlyphs, "Material", { trim: MATERIAL_TRIM }),
  circleFilled: createStateDotIcon("Material"),
};
