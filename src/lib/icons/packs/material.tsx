import { materialGlyphs } from "../generated/material";
import { createGlyphIcons } from "../glyph";
import type { IconMapping } from "../types";
import { createStateDotIcon } from "./state-dot";

export const mapping: IconMapping = {
  ...createGlyphIcons(materialGlyphs, "Material"),
  circleFilled: createStateDotIcon("Material"),
};
