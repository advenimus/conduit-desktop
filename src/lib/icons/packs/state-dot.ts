import { createGlyphIcon, type GlyphIcon } from "../glyph";
import type { IconComponent } from "../types";

// The packs' own filled circles span 12 to 13px of a 16px box. Tab and status bar
// dots must match the Codicons dot in every pack: an 8px disc, also at the 12px
// compact size (spec 3.6, 3.10, 5.2).
const STATE_DOT: GlyphIcon = {
  w: 16,
  h: 16,
  nodes: [{ tag: "path", attrs: { fill: "currentColor", d: "M8 4a4 4 0 1 1 0 8a4 4 0 0 1 0-8" } }],
  compact: {
    w: 12,
    h: 12,
    nodes: [{ tag: "path", attrs: { fill: "currentColor", d: "M6 2a4 4 0 1 1 0 8a4 4 0 0 1 0-8" } }],
  },
};

export function createStateDotIcon(packLabel: string): IconComponent {
  return createGlyphIcon(STATE_DOT, `${packLabel}(circleFilled)`);
}
