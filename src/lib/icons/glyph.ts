import { createElement, memo, type ReactElement } from "react";
import { iconA11yAttributes } from "./a11y";
import { DEFAULT_ICON_SIZE, type IconComponent, type IconProps, type SemanticIconName } from "./types";

export type GlyphAttribute = "d" | "fill" | "fill-rule" | "clip-rule" | "transform" | "opacity";

export interface GlyphNode {
  readonly tag: "path" | "g";
  readonly attrs: Readonly<Partial<Record<GlyphAttribute, string>>>;
  readonly children?: ReadonlyArray<GlyphNode>;
}

export interface Glyph {
  readonly w: number;
  readonly h: number;
  readonly nodes: ReadonlyArray<GlyphNode>;
}

export interface GlyphIcon extends Glyph {
  readonly compact?: Glyph;
}

export type GlyphSet = Partial<Record<SemanticIconName, GlyphIcon>>;

const COMPACT_MAX_SIZE = 12;

const REACT_ATTRIBUTE: Readonly<Record<GlyphAttribute, string>> = {
  d: "d",
  fill: "fill",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  transform: "transform",
  opacity: "opacity",
};

function toReactProps(attrs: GlyphNode["attrs"], key: string): Record<string, string> {
  const entries = Object.entries(attrs).map(([name, value]) => [REACT_ATTRIBUTE[name as GlyphAttribute], value ?? ""]);
  return { ...Object.fromEntries(entries), key };
}

function renderNodes(nodes: ReadonlyArray<GlyphNode>, prefix = ""): ReactElement[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${index}`;
    const children = node.children ? renderNodes(node.children, `${key}.`) : undefined;
    return createElement(node.tag, toReactProps(node.attrs, key), children);
  });
}

export interface GlyphOptions {
  /** viewBox units cut from each side of a full-size glyph, so a pack drawn inside padding fills the box. */
  readonly trim?: number;
}

function viewBoxFor(glyph: Glyph, trim: number): string {
  return trim === 0 ? `0 0 ${glyph.w} ${glyph.h}` : `${trim} ${trim} ${glyph.w - 2 * trim} ${glyph.h - 2 * trim}`;
}

/** Renders generated path data as an <svg> that draws with currentColor. */
export function createGlyphIcon(icon: GlyphIcon, displayName: string, options: GlyphOptions = {}): IconComponent {
  const trim = options.trim ?? 0;
  const fullNodes = renderNodes(icon.nodes);
  const compactGlyph = icon.compact ?? null;
  const compactNodes = compactGlyph ? renderNodes(compactGlyph.nodes) : null;

  const GlyphIconComponent = memo(function GlyphIconComponent(props: IconProps) {
    const size = props.size ?? DEFAULT_ICON_SIZE;
    const useCompact = compactGlyph !== null && (props.compact === true || size <= COMPACT_MAX_SIZE);
    const glyph = useCompact && compactGlyph ? compactGlyph : icon;
    return createElement(
      "svg",
      {
        viewBox: viewBoxFor(glyph, useCompact ? 0 : trim),
        width: size,
        height: size,
        fill: "currentColor",
        className: props.className,
        style: props.style,
        ...iconA11yAttributes(props.title),
      },
      useCompact ? compactNodes : fullNodes,
    );
  });
  GlyphIconComponent.displayName = displayName;
  return GlyphIconComponent;
}

/** Wraps every glyph of a generated set, keeping its exact keys. */
export function createGlyphIcons<K extends SemanticIconName>(
  glyphs: Readonly<Record<K, GlyphIcon>>,
  packLabel: string,
  options: GlyphOptions = {},
): Record<K, IconComponent> {
  const entries = (Object.keys(glyphs) as K[]).map((name) => [name, createGlyphIcon(glyphs[name], `${packLabel}(${name})`, options)]);
  return Object.fromEntries(entries) as Record<K, IconComponent>;
}
