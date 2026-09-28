import { describe, it, expect, afterAll } from "vitest";
import { ICON_PACKS, SEMANTIC_ICON_NAMES, iconToSvg, preloadAllIconPacks, setIconPack } from "..";

const MAX_MENU_SVG_BYTES = 8 * 1024;
// The first import of the five lazy packs takes about 2.5 s alone and passed 5 s in a loaded full run.
const PRELOAD_TIMEOUT_MS = 30_000;

afterAll(async () => {
  await setIconPack("codicons");
});

describe("iconToSvg", () => {
  it("returns sized <svg> markup for the active pack", () => {
    const svg = iconToSvg("close");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="16"');
    expect(svg).toContain('height="16"');
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('aria-hidden="true"');
  });

  it("returns the cached markup for the same pack, name and size", () => {
    expect(iconToSvg("folder", 16)).toBe(iconToSvg("folder", 16));
    expect(iconToSvg("close", 12)).toContain('viewBox="0 0 12 12"');
    expect(iconToSvg("close", 12)).toContain('width="12"');
  });

  it("resets when the pack changes", async () => {
    const codicon = iconToSvg("close");
    await setIconPack("lucide");
    const lucide = iconToSvg("close");
    expect(lucide.startsWith("<svg")).toBe(true);
    expect(lucide).not.toBe(codicon);
    expect(lucide).toContain('viewBox="0 0 24 24"');

    await setIconPack("codicons");
    expect(iconToSvg("close")).toBe(codicon);
  });

  it("produces menu-safe markup for every name in every pack", async () => {
    await preloadAllIconPacks();
    for (const { id } of ICON_PACKS) {
      await setIconPack(id);
      for (const name of SEMANTIC_ICON_NAMES) {
        const svg = iconToSvg(name, 16);
        const where = `${id}:${name}`;
        expect(svg.startsWith("<svg"), where).toBe(true);
        expect(svg, where).toContain('width="16"');
        expect(svg, where).toContain('height="16"');
        expect(svg, where).not.toMatch(/\sstyle=|\sclass=|\son[a-z]+=|href=|<script|<foreignObject/i);
        expect(svg.length, where).toBeLessThanOrEqual(MAX_MENU_SVG_BYTES);
      }
    }
  }, PRELOAD_TIMEOUT_MS);
});
