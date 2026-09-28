// Test helper: models how the compiled token CSS resolves on <html> for one scheme, mode and density.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AtRule, type Root, type Rule } from "postcss";
import tailwind from "@tailwindcss/postcss";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface RootState {
  mode: "dark" | "light";
  scheme?: string;
  density?: "comfortable" | "compact";
  os?: "macos" | "windows" | "linux";
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TokenRule {
  selector: string;
  parts: string[];
  decls: Map<string, string>;
  order: number;
  inMedia: string | null;
  inLayer: string | null;
}

export async function compileIndexCss(): Promise<Root> {
  const from = path.join(REPO_ROOT, "src", "index.css");
  const result = await postcss([tailwind({ base: REPO_ROOT })]).process(fs.readFileSync(from, "utf8"), { from });
  return result.root;
}

function enclosing(rule: Rule, name: string): AtRule | null {
  let node = rule.parent;
  while (node && node.type !== "root") {
    if (node.type === "atrule" && (node as AtRule).name === name) return node as AtRule;
    node = node.parent;
  }
  return null;
}

/**
 * Every rule that declares at least one --c-* custom property, in source order. Tailwind rewrites a
 * color-mix() declaration into a fallback plus a nested @supports (color: color-mix(...)) copy; Chromium
 * supports color-mix(), so the nested copy is the one that applies (it comes later in the same rule).
 */
export function tokenRules(root: Root): TokenRule[] {
  const rules: TokenRule[] = [];
  root.walkRules((rule) => {
    const decls = new Map<string, string>();
    rule.walkDecls((decl) => {
      if (!decl.prop.startsWith("--c-")) return;
      const parent = decl.parent;
      const direct = parent === rule;
      const supportsColorMix =
        parent?.type === "atrule" && (parent as AtRule).name === "supports" && (parent as AtRule).params.includes("color-mix") && parent.parent === rule;
      if (direct || supportsColorMix) decls.set(decl.prop, decl.value.trim());
    });
    if (decls.size === 0) return;
    rules.push({
      selector: rule.selector,
      parts: splitTopLevel(rule.selector, ",").map((s) => s.trim()),
      decls,
      order: rules.length,
      inMedia: enclosing(rule, "media")?.params ?? null,
      inLayer: enclosing(rule, "layer")?.params ?? null,
    });
  });
  return rules;
}

export function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

interface Match {
  matches: boolean;
  specificity: number;
}

/** Matches one compound selector against <html>; null when it has syntax this model does not cover. */
export function matchRoot(selector: string, state: RootState): Match | null {
  const attrs: Record<string, string | undefined> = {
    "data-scheme": state.scheme,
    "data-density": state.density ?? "comfortable",
    "data-os": state.os,
  };
  let rest = selector.trim();
  let specificity = 0;
  let matches = true;
  while (rest.length > 0) {
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^:root/))) {
      specificity += 10;
    } else if ((m = rest.match(/^\.([\w-]+)/))) {
      specificity += 10;
      if (m[1] !== state.mode) matches = false;
    } else if ((m = rest.match(/^\[([\w-]+)(?:="([^"]*)")?\]/))) {
      specificity += 10;
      const value = attrs[m[1]];
      if (m[2] === undefined ? value === undefined : value !== m[2]) matches = false;
    } else if ((m = rest.match(/^:(not|where)\(/))) {
      const close = matchingParen(rest, m[0].length - 1);
      const inner = rest.slice(m[0].length, close);
      const results = splitTopLevel(inner, ",").map((s) => matchRoot(s, state));
      if (results.some((r) => r === null)) return null;
      const any = results.some((r) => r!.matches);
      if (m[1] === "not") {
        specificity += Math.max(...results.map((r) => r!.specificity));
        if (any) matches = false;
      } else if (!any) {
        matches = false;
      }
      rest = rest.slice(close + 1);
      continue;
    } else {
      return null;
    }
    rest = rest.slice(m[0].length);
  }
  return { matches, specificity };
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  throw new Error(`Unbalanced parentheses in ${text}`);
}

/** Declared values on <html> after the cascade: highest specificity wins, then the later rule. */
export function cascade(rules: TokenRule[], state: RootState): Map<string, string> {
  const winners = new Map<string, { value: string; specificity: number; order: number }>();
  for (const rule of rules) {
    if (rule.inMedia !== null) continue;
    let best = -1;
    for (const part of rule.parts) {
      const m = matchRoot(part, state);
      if (m?.matches) best = Math.max(best, m.specificity);
    }
    if (best < 0) continue;
    for (const [prop, value] of rule.decls) {
      const prev = winners.get(prop);
      if (!prev || best > prev.specificity || (best === prev.specificity && rule.order >= prev.order)) {
        winners.set(prop, { value, specificity: best, order: rule.order });
      }
    }
  }
  return new Map([...winners].map(([k, v]) => [k, v.value]));
}

export class TokenResolver {
  private readonly cache = new Map<string, Rgba>();

  constructor(private readonly declared: Map<string, string>) {}

  has(token: string): boolean {
    return this.declared.has(token);
  }

  raw(token: string): string | undefined {
    return this.declared.get(token);
  }

  color(token: string, seen: string[] = []): Rgba {
    const cached = this.cache.get(token);
    if (cached) return cached;
    if (seen.includes(token)) throw new Error(`Cycle: ${[...seen, token].join(" -> ")}`);
    const value = this.declared.get(token);
    if (value === undefined) throw new Error(`${token} is not declared`);
    const color = this.parse(value, [...seen, token]);
    this.cache.set(token, color);
    return color;
  }

  private parse(text: string, seen: string[]): Rgba {
    const value = text.trim();
    const call = value.match(/^([a-z-]+)\((.*)\)$/is);
    if (call) {
      const [, fn, body] = call;
      if (fn === "var") return this.color(body.trim(), seen);
      if (fn === "color-mix") return this.colorMix(body, seen);
      if (fn === "rgb" || fn === "rgba") return parseRgbFunction(body);
      throw new Error(`Unsupported color function ${fn}() in "${text}"`);
    }
    return parseColorLiteral(value);
  }

  private colorMix(body: string, seen: string[]): Rgba {
    const [space, first, second] = splitTopLevel(body, ",").map((s) => s.trim());
    if (space !== "in srgb") throw new Error(`Only "in srgb" is supported, got "${space}"`);
    const a = this.mixPart(first, seen);
    const b = this.mixPart(second, seen);
    const pa = a.pct ?? (b.pct === null ? 50 : 100 - b.pct);
    const pb = b.pct ?? 100 - pa;
    if (Math.abs(pa + pb - 100) > 1e-9) throw new Error(`color-mix percentages must add to 100: ${body}`);
    return mixSrgb(a.color, pa / 100, b.color, pb / 100);
  }

  private mixPart(text: string, seen: string[]): { color: Rgba; pct: number | null } {
    const m = text.match(/^(.*?)\s+([\d.]+)%$/s);
    if (m) return { color: this.parse(m[1], seen), pct: Number(m[2]) };
    return { color: this.parse(text, seen), pct: null };
  }
}

export function parseColorLiteral(text: string): Rgba {
  const value = text.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (!hex || ![3, 6, 8].includes(hex[1].length)) throw new Error(`Not a color: "${text}"`);
  const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
  const byte = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: h.length === 8 ? byte(6) : 1 };
}

function parseRgbFunction(body: string): Rgba {
  const parts = body.replace("/", " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new Error(`Bad rgb(): ${body}`);
  const channel = (p: string) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p) / 255);
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
  return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha };
}

/** CSS Color 5 color-mix() in sRGB: premultiplied interpolation, no rounding. */
export function mixSrgb(a: Rgba, pa: number, b: Rgba, pb: number): Rgba {
  const alpha = a.a * pa + b.a * pb;
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x: number, y: number) => (x * a.a * pa + y * b.a * pb) / alpha;
  return { r: ch(a.r, b.r), g: ch(a.g, b.g), b: ch(a.b, b.b), a: alpha };
}

export function composite(fg: Rgba, bg: Rgba): Rgba {
  if (bg.a < 1) throw new Error(`Cannot composite on a translucent surface (${toHex(bg)})`);
  const ch = (x: number, y: number) => x * fg.a + y * (1 - fg.a);
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a: 1 };
}

function luminance(c: Rgba): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast; the foreground is composited on the opaque background first. */
export function contrast(fg: Rgba, bg: Rgba): number {
  const solidFg = composite(fg, bg);
  const [hi, lo] = [luminance(solidFg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex(c: Rgba): string {
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}${c.a < 1 ? byte(c.a) : ""}`.toUpperCase();
}

export function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
}
