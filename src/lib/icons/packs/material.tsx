import { materialGlyphs } from "../generated/material";
import { createGlyphIcons } from "../glyph";
import type { IconMapping } from "../types";

export const mapping: IconMapping = createGlyphIcons(materialGlyphs, "Material");
