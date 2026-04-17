/**
 * Ubuntu / GNOME icon pack — reuses Tabler icons with bolder stroke weight.
 * GNOME Adwaita icons have a similar geometric style to Tabler but use
 * heavier strokes (2.0 vs 1.5). This gives the bolder Adwaita feel
 * with zero additional dependencies.
 *
 * The stroke weight difference is handled by THEME_ICON_DEFAULTS in types.ts
 * (strokeWidth: 2.0 for ubuntu), so this mapping is identical to default.
 */

import { mapping as defaultMapping } from "./default";
import type { IconMapping } from "../types";

export const mapping: IconMapping = defaultMapping;
