import { createElement, memo } from "react";
import type { LucideIcon } from "lucide-react";
import { iconA11yAttributes } from "../a11y";
import { DEFAULT_ICON_SIZE, type IconComponent, type IconProps } from "../types";

// Lucide's default 2px stroke reads heavy next to Codicons (spec 5.2).
export const LUCIDE_STROKE_WIDTH = 1.5;

export function wrapLucide(LucideComponent: LucideIcon, options: { filled?: boolean } = {}): IconComponent {
  // Only set fill when filled: an explicit undefined would drop Lucide's fill="none".
  const fillProps = options.filled ? { fill: "currentColor" } : {};
  const Wrapped = memo(function WrappedLucideIcon(props: IconProps) {
    return createElement(LucideComponent, {
      size: props.size ?? DEFAULT_ICON_SIZE,
      strokeWidth: props.stroke ?? LUCIDE_STROKE_WIDTH,
      ...fillProps,
      className: props.className,
      style: props.style,
      ...iconA11yAttributes(props.title),
    });
  });
  Wrapped.displayName = `Lucide(${LucideComponent.displayName ?? "icon"})`;
  return Wrapped;
}
