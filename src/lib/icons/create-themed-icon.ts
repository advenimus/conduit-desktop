import { createElement, memo } from "react";
import { useIconPackStore } from "./store";
import { DEFAULT_ICON_SIZE, type IconComponent, type IconProps, type SemanticIconName } from "./types";

/** A named icon component that renders `name` from the active pack. */
export function createThemedIcon(name: SemanticIconName): IconComponent {
  const ThemedIcon = memo(function ThemedIcon(props: IconProps) {
    const PackIcon = useIconPackStore((state) => state.mapping[name]);
    return createElement(PackIcon, { ...props, size: props.size ?? DEFAULT_ICON_SIZE });
  });
  ThemedIcon.displayName = `Icon(${name})`;
  return ThemedIcon;
}
