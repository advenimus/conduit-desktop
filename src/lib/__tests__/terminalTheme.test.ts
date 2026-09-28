import { afterEach, describe, expect, it, vi } from "vitest";
import { getTerminalTheme } from "../terminalTheme";

const HEX = /^#[0-9a-f]{6}$/;

function stubComputedColors(colors: Record<string, string>): void {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
    const token = (element as HTMLElement).style?.color?.match(/^var\((--c-[\w-]+)\)$/)?.[1];
    if (!token) return real(element, pseudo);
    // Like Chromium: an unknown token inherits the parent's color.
    const inherited = (element.parentElement as HTMLElement | null)?.style.color || "rgb(0, 0, 0)";
    return { color: colors[token] ?? inherited } as CSSStyleDeclaration;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark", "light");
});

describe("getTerminalTheme", () => {
  it("uses the editor surface, resolved to hex even when the token is a color-mix()", () => {
    document.documentElement.classList.add("dark");
    stubComputedColors({
      "--c-editor": "color(srgb 0.0705882 0.0745098 0.0784314)",
      "--c-ink": "rgb(237, 237, 237)",
      "--c-ink-muted": "rgb(157, 157, 157)",
      "--c-shell": "rgb(25, 26, 27)",
    });
    const theme = getTerminalTheme();
    expect(theme.background).toBe("#121314");
    expect(theme.foreground).toBe("#ededed");
    expect(theme.cursor).toBe("#ededed");
    expect(theme.cursorAccent).toBe("#121314");
    expect(theme.selectionBackground).toBe("rgba(157, 157, 157, 0.3)");
  });

  it("flattens a translucent token before using it", () => {
    document.documentElement.classList.add("light");
    stubComputedColors({
      "--c-editor": "rgb(255, 255, 255)",
      "--c-ink": "rgb(32, 32, 32)",
      "--c-ink-muted": "rgba(0, 0, 0, 0.5)",
      "--c-shell": "rgb(250, 250, 253)",
    });
    const theme = getTerminalTheme();
    expect(theme.background).toMatch(HEX);
    expect(theme.selectionBackground).toBe("rgba(125, 125, 127, 0.25)");
  });

  it("falls back to fixed hex colors when the tokens are not available", () => {
    document.documentElement.classList.add("dark");
    stubComputedColors({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const theme = getTerminalTheme();
    expect(theme.background).toMatch(HEX);
    expect(theme.foreground).toMatch(HEX);
    expect(theme.selectionBackground).toMatch(/^rgba\(\d+, \d+, \d+, 0\.3\)$/);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps the fixed ANSI palette", () => {
    document.documentElement.classList.add("dark");
    stubComputedColors({});
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const theme = getTerminalTheme();
    expect(theme.red).toBe("#ef4444");
    expect(theme.brightWhite).toBe("#ffffff");
  });
});
