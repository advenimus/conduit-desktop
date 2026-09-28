import { createElement, memo } from "react";
import { iconA11yAttributes } from "../a11y";
import { DEFAULT_ICON_SIZE, type IconComponent, type IconProps } from "../types";

/** One glyph of @hugeicons/core-free-icons: [tag, attributes] pairs on a 24px grid (IconSvgObject). */
export type HugeiconsGlyph = ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]>;

export const HUGEICONS_STROKE_WIDTH = 1.5;
const TAGS: ReadonlySet<string> = new Set(["path", "circle", "ellipse", "line", "polyline", "polygon", "rect", "g"]);

// A local renderer instead of @hugeicons/react: that component adds a `color` attribute
// the popup menu sanitizer drops, and it would be one more runtime package (spec 5.2, D-10).
export function wrapHugeicon(glyph: HugeiconsGlyph, name: string, options: { filled?: boolean } = {}): IconComponent {
  const Wrapped = memo(function WrappedHugeicon(props: IconProps) {
    const size = props.size ?? DEFAULT_ICON_SIZE;
    const strokeWidth = props.stroke ?? HUGEICONS_STROKE_WIDTH;
    const children = glyph.map(([tag, { key, ...attrs }], index) => {
      if (!TAGS.has(tag)) throw new Error(`Hugeicons ${name}: unexpected <${tag}>`);
      return createElement(tag, {
        ...attrs,
        ...("strokeWidth" in attrs ? { strokeWidth } : {}),
        ...(options.filled ? { fill: "currentColor" } : {}),
        key: String(key ?? index),
      });
    });
    return createElement(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        className: props.className,
        style: props.style,
        ...iconA11yAttributes(props.title),
      },
      children,
    );
  });
  Wrapped.displayName = `Hugeicons(${name})`;
  return Wrapped;
}
