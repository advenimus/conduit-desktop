import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useIconPackStore } from "./store";
import { DEFAULT_ICON_SIZE, type IconComponent, type SemanticIconName } from "./types";

const cache = new Map<string, string>();

useIconPackStore.subscribe((state, previous) => {
  if (state.mapping !== previous.mapping) cache.clear();
});

// Classes and inline styles mean nothing in the popup menu window, and the main
// process rejects `style`; the size moves into width and height attributes.
function normalizeSvg(svg: SVGSVGElement, size: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute("class");
  clone.removeAttribute("style");
  clone.setAttribute("width", String(size));
  clone.setAttribute("height", String(size));
  return clone.outerHTML;
}

function renderToSvg(PackIcon: IconComponent, size: number): string {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(PackIcon, { size })));
    const svg = host.querySelector("svg");
    if (!svg) throw new Error("the icon rendered no <svg>");
    return normalizeSvg(svg, size);
  } finally {
    root.unmount();
  }
}

/**
 * The active pack's icon as `<svg>` markup, for the native popup menu. Call it
 * from event handlers, not during render (it renders synchronously).
 */
export function iconToSvg(name: SemanticIconName, size: number = DEFAULT_ICON_SIZE): string {
  const { pack, mapping } = useIconPackStore.getState();
  const key = `${pack}:${name}:${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const markup = renderToSvg(mapping[name], size);
  cache.set(key, markup);
  return markup;
}
