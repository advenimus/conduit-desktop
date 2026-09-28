import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { GalleryApp } from "../gallery/GalleryApp";
import { gallerySearch, readGalleryState } from "../gallery/galleryState";
import { installStateMirror, mirrorRules, MIRROR_STYLE_ID } from "../gallery/stateMirror";
import { DEFAULT_ICON_PACK, ICON_PACKS, SEMANTIC_ICON_NAMES, preloadAllIconPacks, setIconPack } from "../../../lib/icons";
import { freezeHolders } from "../../../lib/native-freeze";

// The first import of the five lazy packs takes seconds in a loaded run.
const PRELOAD_TIMEOUT_MS = 30_000;

beforeAll(async () => {
  await preloadAllIconPacks();
}, PRELOAD_TIMEOUT_MS);

afterEach(async () => {
  cleanup();
  await act(() => setIconPack(DEFAULT_ICON_PACK));
  document.getElementById(MIRROR_STYLE_ID)?.remove();
  window.history.replaceState(null, "", "/");
});

describe("gallery state", () => {
  it("reads and writes the three switches and the section filter through the URL, with no density", () => {
    const state = readGalleryState("?scheme=ocean&mode=light&density=compact&pack=hugeicons&section=focus");
    expect(state).toEqual({ scheme: "ocean", mode: "light", pack: "hugeicons", section: "focus" });
    expect(readGalleryState(gallerySearch(state))).toEqual(state);
    expect(gallerySearch(state)).not.toContain("density");
    expect(readGalleryState("?scheme=nope&mode=dim&pack=codicons")).toEqual({ scheme: "modern", mode: "dark", pack: "lucide", section: null });
  });
});

describe("GalleryApp", () => {
  it("renders every section without console errors and applies the switches to <html>", async () => {
    const errors = vi.spyOn(console, "error");
    window.history.replaceState(null, "", "/gallery.html?scheme=forest&mode=light");
    render(<GalleryApp />);
    await act(async () => {});
    for (const id of ["focus", "buttons", "fields", "navigation", "overlays", "rows", "display", "icons"]) {
      expect(document.querySelector(`[data-gallery-section="${id}"]`)).not.toBeNull();
    }
    expect(document.querySelector('[data-gallery-section="workbench"]')).toBeNull();
    const root = document.documentElement;
    expect(root.getAttribute("data-scheme")).toBe("forest");
    expect(root.classList.contains("light")).toBe(true);
    expect(root.hasAttribute("data-density")).toBe(false);

    const toolbar = within(screen.getByRole("banner"));
    expect(toolbar.queryByRole("radiogroup", { name: "Density" })).toBeNull();
    const packs = [...toolbar.getByRole("combobox", { name: "Icon pack" }).querySelectorAll("option")].map((o) => o.value);
    expect(packs).toEqual(ICON_PACKS.map((pack) => pack.id));
    fireEvent.change(toolbar.getByRole("combobox", { name: "Color scheme" }), { target: { value: "rose" } });
    fireEvent.click(toolbar.getByRole("radio", { name: "Dark" }));
    await act(async () => {});
    expect(root.getAttribute("data-scheme")).toBe("rose");
    expect(root.classList.contains("dark")).toBe(true);
    expect(window.location.search).toContain("scheme=rose");
    expect(errors).not.toHaveBeenCalled();
    expect(freezeHolders()).toEqual([]);
    errors.mockRestore();
  });

  it.each(ICON_PACKS.map((pack) => pack.id))("?pack=%s draws every icon and the state dot from that pack", async (pack) => {
    const errors = vi.spyOn(console, "error");
    window.history.replaceState(null, "", `/gallery.html?pack=${pack}&section=icons`);
    render(<GalleryApp />);
    await act(async () => {});
    expect(document.documentElement.getAttribute("data-cv-icon-pack")).toBe(pack);
    const cells = document.querySelectorAll("[data-gallery-icon]");
    expect(cells).toHaveLength(SEMANTIC_ICON_NAMES.length);
    for (const cell of cells) expect(cell.querySelectorAll("svg"), cell.getAttribute("data-gallery-icon")!).toHaveLength(1);
    expect(document.querySelectorAll("[data-gallery-pack]")).toHaveLength(ICON_PACKS.length);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("shows one section with ?section=", async () => {
    window.history.replaceState(null, "", "/gallery.html?section=focus");
    render(<GalleryApp />);
    await act(async () => {});
    expect(document.querySelectorAll("[data-gallery-section]")).toHaveLength(1);
    expect(document.querySelector('[data-gallery-section="focus"]')).not.toBeNull();
  });
});

describe("state mirror with nested rules", () => {
  it("follows Tailwind's nested variant rules (dev output) and keeps the parent selector as context", () => {
    const decl = (cssText: string) => ({ cssText });
    const rules = [
      {
        name: "utilities",
        cssRules: [
          { selectorText: ".focus-within\\:outline", style: decl(""), cssRules: [{ selectorText: "&:focus-within", style: decl("outline-style: solid;") }] },
          {
            selectorText: ".hover\\:bg-hover",
            style: decl(""),
            cssRules: [{ media: {}, conditionText: "(hover: hover)", cssRules: [{ selectorText: "&:hover", style: decl("background-color: red;") }] }],
          },
          { selectorText: ".a:hover", style: decl("color: blue;"), cssRules: [{ selectorText: "& .b", style: decl("color: green;") }] },
          { selectorText: ".plain", style: decl("color: black;"), cssRules: [{ selectorText: "& .c", style: decl("color: gray;") }] },
          {
            // Chrome: &:hover { @media (hover: hover) { declarations } } holds a nested-declarations rule.
            selectorText: ".hover\\:text-ink",
            style: decl(""),
            cssRules: [{ selectorText: "&:hover", style: decl(""), cssRules: [{ media: {}, conditionText: "(hover: hover)", cssRules: [{ style: decl("color: white;") }] }] }],
          },
          { selectorText: ".still", style: decl(""), cssRules: [{ media: {}, conditionText: "(hover: hover)", cssRules: [{ style: decl("color: gray;") }] }] },
          {
            // An escaped colon in a class name is not a pseudo-class.
            selectorText: ".enabled\\:hover\\:bg-x",
            style: decl(""),
            cssRules: [{ selectorText: "&:enabled", style: decl(""), cssRules: [{ selectorText: "&:hover", style: decl("background: gray;") }] }],
          },
        ],
      },
    ];
    expect(mirrorRules(rules)).toEqual([
      "@layer utilities { .focus-within\\:outline { &:is([data-gallery-focus], :has([data-gallery-focus])) { outline-style: solid; } } }",
      "@layer utilities { .hover\\:bg-hover { @media (hover: hover) { &[data-gallery-hover] { background-color: red; } } } }",
      "@layer utilities { .a[data-gallery-hover] { color: blue; } }",
      "@layer utilities { .a[data-gallery-hover] { & .b { color: green; } } }",
      "@layer utilities { .hover\\:text-ink { &[data-gallery-hover] { @media (hover: hover) { color: white; } } } }",
      "@layer utilities { .enabled\\:hover\\:bg-x { &:enabled { &[data-gallery-hover] { background: gray; } } } }",
    ]);
  });
});

describe("state mirror", () => {
  it("copies state rules onto data-gallery-* attributes, keeping @media, and skips negated states", () => {
    const style = document.createElement("style");
    style.textContent = [
      "button:focus-visible { outline: 1px solid red; }",
      ".wrap:focus-within { color: blue; }",
      "@media (hover: hover) { .row:hover { background: green; } }",
      ".tab:not(:hover) .x { opacity: 0; }",
      ".plain { color: black; }",
    ].join("\n");
    document.head.appendChild(style);
    expect(installStateMirror()).toBe(3);
    const mirror = document.getElementById(MIRROR_STYLE_ID)?.textContent ?? "";
    expect(mirror).toContain("button[data-gallery-focus]");
    expect(mirror).toContain(".wrap:is([data-gallery-focus], :has([data-gallery-focus]))");
    expect(mirror).toMatch(/@media \(hover: hover\) \{ \.row\[data-gallery-hover\]/);
    expect(mirror).not.toContain(".tab");
    style.remove();
  });
});
