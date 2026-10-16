import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FONT_FAMILY_LENGTH,
  TERMINAL_FONT_FALLBACK,
  buildTerminalFontStack,
  isFontInstalled,
  listInstalledFontFamilies,
  loadTerminalFont,
  sanitizeFontFamily,
} from "../terminalFont";
import { HARDCODED_TERMINAL_DEFAULTS } from "../../types/entry";
import * as mainMirror from "../../../electron/services/terminal-font";

const UNSAFE_NAMES = [
  'Maple"Mono',
  "Maple'Mono",
  "Maple`Mono",
  "Maple, Arial",
  "Maple; color: red",
  "Maple{}",
  "Maple\\Mono",
  "Maple<Mono>",
  "Maple\nMono",
  "Maple\u0000Mono",
  "Maple\u007fMono",
  "x".repeat(MAX_FONT_FAMILY_LENGTH + 1),
];

describe("sanitizeFontFamily", () => {
  it("keeps a plain installed font name and trims it", () => {
    expect(sanitizeFontFamily("  Maple Mono NF  ")).toBe("Maple Mono NF");
    expect(sanitizeFontFamily("JetBrainsMono Nerd Font Mono")).toBe("JetBrainsMono Nerd Font Mono");
    expect(sanitizeFontFamily("x".repeat(MAX_FONT_FAMILY_LENGTH))).toHaveLength(MAX_FONT_FAMILY_LENGTH);
  });

  it("treats empty and non-string values as the default", () => {
    for (const raw of ["", "   ", undefined, null, 42, {}]) expect(sanitizeFontFamily(raw)).toBe("");
  });

  it.each(UNSAFE_NAMES)("rejects a name that could break out of the CSS font list: %j", (raw) => {
    expect(sanitizeFontFamily(raw)).toBe("");
  });
});

describe("buildTerminalFontStack", () => {
  it("puts the chosen font first and keeps the built-in fonts after it", () => {
    expect(buildTerminalFontStack("Maple Mono NF")).toBe(`"Maple Mono NF", ${TERMINAL_FONT_FALLBACK}`);
  });

  it("uses only the built-in fonts when nothing (or something unsafe) is set", () => {
    expect(buildTerminalFontStack("")).toBe(TERMINAL_FONT_FALLBACK);
    expect(buildTerminalFontStack('a", b')).toBe(TERMINAL_FONT_FALLBACK);
    expect(TERMINAL_FONT_FALLBACK).toBe('Menlo, Monaco, Consolas, "Courier New", monospace');
  });
});

describe("main process mirror (electron/services/terminal-font.ts)", () => {
  it("has the same terminal defaults as the renderer", () => {
    expect(mainMirror.HARDCODED_TERMINAL_DEFAULTS).toEqual(HARDCODED_TERMINAL_DEFAULTS);
    expect(HARDCODED_TERMINAL_DEFAULTS.fontFamily).toBe("");
  });

  it.each([...UNSAFE_NAMES, "  Maple Mono NF ", "", undefined, 7])("sanitizes %j the same way", (raw) => {
    expect(mainMirror.sanitizeFontFamily(raw)).toBe(sanitizeFontFamily(raw));
  });
});

describe("isFontInstalled", () => {
  function fakeContext(widths: Record<string, number>) {
    let font = "";
    return {
      get font() {
        return font;
      },
      set font(value: string) {
        font = value;
      },
      measureText: () => ({ width: widths[font] ?? 100 }),
    };
  }

  it("is true when the font changes the width of the probe text", () => {
    const ctx = fakeContext({ '72px "Maple Mono NF", monospace': 120 });
    expect(isFontInstalled("Maple Mono NF", ctx)).toBe(true);
  });

  it("is false when every generic fallback measures the same", () => {
    expect(isFontInstalled("Not A Font", fakeContext({}))).toBe(false);
  });

  it("is unknown without a canvas or a usable name", () => {
    expect(isFontInstalled("Maple Mono NF", null)).toBeNull();
    expect(isFontInstalled("", fakeContext({}))).toBeNull();
  });
});

describe("listInstalledFontFamilies", () => {
  const original = (window as { queryLocalFonts?: unknown }).queryLocalFonts;
  afterEach(() => {
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = original;
  });

  it("is null when the system cannot list fonts", async () => {
    delete (window as { queryLocalFonts?: unknown }).queryLocalFonts;
    expect(await listInstalledFontFamilies()).toBeNull();
  });

  it("returns each family once, sorted", async () => {
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => [
      { family: "Menlo" },
      { family: "Maple Mono NF" },
      { family: "Maple Mono NF" },
      { family: "" },
      { family: "Arial" },
    ]);
    expect(await listInstalledFontFamilies()).toEqual(["Arial", "Maple Mono NF", "Menlo"]);
  });

  it("passes a permission error on to the caller", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    (window as { queryLocalFonts?: unknown }).queryLocalFonts = vi.fn(async () => {
      throw denied;
    });
    await expect(listInstalledFontFamilies()).rejects.toBe(denied);
  });
});

describe("loadTerminalFont", () => {
  const original = Object.getOwnPropertyDescriptor(document, "fonts");
  afterEach(() => {
    if (original) Object.defineProperty(document, "fonts", original);
    else delete (document as { fonts?: unknown }).fonts;
  });

  function stubFonts(load: (font: string) => Promise<unknown>) {
    Object.defineProperty(document, "fonts", { value: { load: vi.fn(load) }, configurable: true });
    return document.fonts.load as unknown as ReturnType<typeof vi.fn>;
  }

  it("asks the browser to load the font at the terminal size", async () => {
    const load = stubFonts(async () => []);
    await loadTerminalFont("Maple Mono NF", 14);
    expect(load).toHaveBeenCalledWith('14px "Maple Mono NF"');
  });

  it("skips the default and never throws when loading fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const load = stubFonts(async () => {
      throw new Error("bad font");
    });
    await loadTerminalFont("", 14);
    expect(load).not.toHaveBeenCalled();
    await expect(loadTerminalFont("Maple Mono NF", 14)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
