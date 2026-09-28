import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCssColor, resolveCssColor } from "../resolveCssColor";

/** jsdom does not resolve var(), so the probe's computed color is stubbed per token. */
function stubComputedColors(colors: Record<string, string>): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const style = (element as HTMLElement).style;
    const token = style?.color?.match(/^var\((--c-[\w-]+)\)$/)?.[1];
    if (!token) return real(element, pseudo);
    return { color: colors[token] ?? "" } as CSSStyleDeclaration;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("parseCssColor", () => {
  it.each([
    ["rgb(18, 19, 20)", { r: 18, g: 19, b: 20, a: 1 }],
    ["rgba(255, 255, 255, 0.08)", { r: 255, g: 255, b: 255, a: 0.08 }],
    ["rgb(0 0 0 / 0.5)", { r: 0, g: 0, b: 0, a: 0.5 }],
    ["color(srgb 0.0705882 0.0745098 0.0784314)", { r: 18, g: 19, b: 20, a: 1 }],
    ["color(srgb 1 1 1 / 0.25)", { r: 255, g: 255, b: 255, a: 0.25 }],
  ])("%s", (input, expected) => {
    const parsed = parseCssColor(input)!;
    for (const key of ["r", "g", "b", "a"] as const) expect(parsed[key]).toBeCloseTo(expected[key], 3);
  });

  it("returns null for anything else", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("var(--c-shell)")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("rgb(1, 2)")).toBeNull();
  });
});

describe("resolveCssColor", () => {
  it("returns #rrggbb for an opaque token in each serialized form", () => {
    stubComputedColors({ "--c-editor": "rgb(18, 19, 20)", "--c-accent": "color(srgb 0.223529 0.580392 0.737255)", "--c-shell": "rgb(25, 26, 27)" });
    expect(resolveCssColor("--c-editor")).toBe("#121314");
    expect(resolveCssColor("--c-accent")).toBe("#3994bc");
  });

  it("flattens alpha on --c-shell by default", () => {
    stubComputedColors({ "--c-hover": "rgba(255, 255, 255, 0.5)", "--c-shell": "rgb(0, 0, 0)" });
    expect(resolveCssColor("--c-hover")).toBe("#808080");
  });

  it("flattens alpha on the surface it is given", () => {
    stubComputedColors({ "--c-menu-selection-bg": "color(srgb 0 0 1 / 0.25)", "--c-overlay": "rgb(255, 255, 255)", "--c-shell": "rgb(0, 0, 0)" });
    expect(resolveCssColor("--c-menu-selection-bg", "--c-overlay")).toBe("#bfbfff");
  });

  it("removes its probe element", () => {
    stubComputedColors({ "--c-editor": "rgb(1, 2, 3)" });
    const before = document.documentElement.childElementCount;
    resolveCssColor("--c-editor");
    expect(document.documentElement.childElementCount).toBe(before);
  });

  it("throws a clear error when the token does not resolve to a color", () => {
    stubComputedColors({});
    expect(() => resolveCssColor("--c-missing")).toThrow(/--c-missing/);
  });
});
