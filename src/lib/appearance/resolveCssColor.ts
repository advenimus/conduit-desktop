/**
 * getComputedStyle returns an unregistered custom property as its token stream, so a color-mix() token
 * comes back as text. Every JS reader of a color token goes through this helper instead (spec 2.12).
 */

export type ColorToken = `--c-${string}`;

export interface Rgba {
  /** 0 to 255 */
  r: number;
  g: number;
  b: number;
  /** 0 to 1 */
  a: number;
}

const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const RGB_LEGACY = new RegExp(String.raw`^rgba?\(\s*(${NUMBER})\s*,\s*(${NUMBER})\s*,\s*(${NUMBER})\s*(?:,\s*(${NUMBER})\s*)?\)$`, "i");
const RGB_MODERN = new RegExp(String.raw`^rgba?\(\s*(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*(?:\/\s*(${NUMBER})\s*)?\)$`, "i");
const SRGB = new RegExp(String.raw`^color\(\s*srgb\s+(${NUMBER})\s+(${NUMBER})\s+(${NUMBER})\s*(?:\/\s*(${NUMBER})\s*)?\)$`, "i");

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/** Parses the forms Chromium serializes a computed color in: rgb(), rgba() and color(srgb r g b / a). */
export function parseCssColor(text: string): Rgba | null {
  const value = text.trim();
  const rgb = value.match(RGB_LEGACY) ?? value.match(RGB_MODERN);
  if (rgb) {
    return { r: clamp(Number(rgb[1]), 255), g: clamp(Number(rgb[2]), 255), b: clamp(Number(rgb[3]), 255), a: rgb[4] === undefined ? 1 : clamp(Number(rgb[4]), 1) };
  }
  const srgb = value.match(SRGB);
  if (srgb) {
    return {
      r: clamp(Number(srgb[1]), 1) * 255,
      g: clamp(Number(srgb[2]), 1) * 255,
      b: clamp(Number(srgb[3]), 1) * 255,
      a: srgb[4] === undefined ? 1 : clamp(Number(srgb[4]), 1),
    };
  }
  return null;
}

/**
 * An undeclared token, or one that is not a color, makes `color: var(token)` invalid at computed-value
 * time, and Chromium then inherits the parent's color instead of failing. The probe's parent carries this
 * sentinel so that case is detectable.
 */
const SENTINEL = { css: "rgba(1, 2, 3, 0.5)", r: 1, g: 2, b: 3, a: 0.5 } as const;

function isSentinel(c: Rgba): boolean {
  return c.r === SENTINEL.r && c.g === SENTINEL.g && c.b === SENTINEL.b && Math.abs(c.a - SENTINEL.a) < 0.01;
}

function probe(token: ColorToken): Rgba {
  const host = document.createElement("span");
  host.style.position = "absolute";
  host.style.visibility = "hidden";
  host.style.pointerEvents = "none";
  host.style.color = SENTINEL.css;
  const span = document.createElement("span");
  span.style.color = `var(${token})`;
  host.appendChild(span);
  document.documentElement.appendChild(host);
  try {
    const computed = window.getComputedStyle(span).color;
    const parsed = parseCssColor(computed);
    if (!parsed || isSentinel(parsed)) throw new Error(`${token} is not declared or does not resolve to a color (got "${computed}")`);
    return parsed;
  } finally {
    host.remove();
  }
}

function toHex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 255)).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Resolves a color token (any syntax) to "#rrggbb" through a probe element, with alpha flattened on `over`
 * (default --c-shell, whose own alpha is ignored). Throws when the token is not a color.
 */
export function resolveCssColor(token: ColorToken, over: ColorToken = "--c-shell"): string {
  const color = probe(token);
  if (color.a >= 1) return toHex(color);
  const bg = probe(over);
  const mix = (fg: number, back: number) => fg * color.a + back * (1 - color.a);
  return toHex({ r: mix(color.r, bg.r), g: mix(color.g, bg.g), b: mix(color.b, bg.b), a: 1 });
}
