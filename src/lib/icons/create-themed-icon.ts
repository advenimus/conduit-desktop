/**
 * Factory that creates a React component for a semantic icon name.
 * The component reads the active icon theme from the Zustand store
 * and renders the correct library-specific icon.
 */

import React from "react";
import { useIconThemeStore } from "./theme-store";
import type { SemanticIconName, IconProps } from "./types";

// The default (Tabler) mapping is imported statically so it's always available.
// Other mappings are loaded lazily when the theme switches.
import { mapping as defaultMapping } from "./packs/default";

export function createThemedIcon(name: SemanticIconName) {
  const ThemedIcon = React.memo(function ThemedIcon(props: IconProps) {
    const themeMapping = useIconThemeStore((s) => s.mapping);
    const defaults = useIconThemeStore((s) => s.defaults);

    // Use theme mapping if loaded, otherwise fall back to default
    const pack = themeMapping ?? defaultMapping;
    const Icon = pack[name];

    return React.createElement(Icon, {
      size: props.size ?? defaults.size,
      stroke: props.stroke ?? defaults.strokeWidth,
      className: props.className,
      style: props.style,
    });
  });

  ThemedIcon.displayName = `Icon(${name})`;
  return ThemedIcon;
}
