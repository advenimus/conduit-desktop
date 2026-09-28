import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import * as icons from "..";
import {
  DEFAULT_ICON_PACK,
  Icon,
  ICON_PACKS,
  SEMANTIC_ICON_NAMES,
  getPackMapping,
  loadIconPack,
  preloadAllIconPacks,
  setIconPack,
  useIconPackStore,
  CloseIcon,
  SettingsIcon,
  TrashIcon,
} from "..";
import type { IconMapping, IconPackId } from "..";
import { HUGEICONS_STROKE_WIDTH, wrapHugeicon, type HugeiconsGlyph } from "../packs/hugeicons-wrap";
import { svgExtent } from "./svg-extent";

const LAZY_PACKS: IconPackId[] = ["phosphor", "hugeicons", "material", "fluent", "tabler"];
// The first import of the five lazy packs takes a few seconds alone and more in a loaded full run.
const PRELOAD_TIMEOUT_MS = 30_000;
const ALL_PACKS = ICON_PACKS.map((pack) => pack.id);
// The popup menu sanitizer's elements (spec 7.1); Hugeicons must stay inside them.
const MENU_SAFE_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect"]);
const RETIRED_NAMES = ["panelLeft", "panelLeftOff", "panelRight", "panelRightOff", "collapseAll", "account", "explorer"];
const RETIRED_EXPORTS = ["PanelLeftIcon", "PanelLeftOffIcon", "PanelRightIcon", "PanelRightOffIcon", "CollapseAllIcon", "AccountIcon", "ExplorerIcon"];

function markup(Component: IconMapping[keyof IconMapping], props: Record<string, unknown> = {}): string {
  const { container, unmount } = render(<Component size={16} {...props} />);
  const html = container.innerHTML;
  unmount();
  return html;
}

function svgOf(Component: IconMapping[keyof IconMapping], props: Record<string, unknown> = {}): SVGSVGElement {
  return render(<Component size={16} {...props} />).container.querySelector("svg")!;
}

function extent(Component: IconMapping[keyof IconMapping], props: Record<string, unknown>) {
  const { container, unmount } = render(<Component {...props} />);
  const result = svgExtent(container.querySelector("svg")!);
  unmount();
  return result;
}

afterEach(async () => {
  cleanup();
  await act(() => setIconPack(DEFAULT_ICON_PACK));
});

describe("the default pack", () => {
  it("is Lucide, bundled: active before any load, with nothing else loaded", () => {
    expect(DEFAULT_ICON_PACK).toBe("lucide");
    expect(getPackMapping("lucide")).not.toBeNull();
    const state = useIconPackStore.getState();
    expect(state.pack).toBe("lucide");
    expect(state.status).toBe("ready");
    expect(state.mapping).toBe(getPackMapping("lucide"));
  });
});

describe("preloadAllIconPacks", () => {
  it("loads the five lazy packs", async () => {
    for (const id of LAZY_PACKS) expect(getPackMapping(id)).toBeNull();

    await act(() => preloadAllIconPacks());

    for (const id of LAZY_PACKS) expect(getPackMapping(id)).not.toBeNull();
    expect([...useIconPackStore.getState().loaded].sort()).toEqual([...ALL_PACKS].sort());
    expect(useIconPackStore.getState().pack).toBe("lucide");
  }, PRELOAD_TIMEOUT_MS);

  it("renders <Icon pack> from the named pack, not the active one", () => {
    for (const id of LAZY_PACKS) {
      const expected = markup(getPackMapping(id)!.folder);
      const { container } = render(<Icon name="folder" pack={id} size={16} />);
      expect(container.innerHTML).toBe(expected);
      expect(container.innerHTML).not.toBe(markup(getPackMapping("lucide")!.folder));
      cleanup();
    }
  });

  it("renders <Icon> without a pack from the active pack", async () => {
    await act(() => setIconPack("hugeicons"));
    const { container } = render(<Icon name="search" />);
    expect(container.innerHTML).toBe(markup(getPackMapping("hugeicons")!.search));
  });
});

describe.each(ALL_PACKS)("%s pack", (id) => {
  it("maps all 117 names and each renders exactly one <svg>", async () => {
    const mapping = await loadIconPack(id);
    expect(SEMANTIC_ICON_NAMES).toHaveLength(117);
    expect(Object.keys(mapping).sort()).toEqual([...SEMANTIC_ICON_NAMES].sort());
    for (const name of SEMANTIC_ICON_NAMES) {
      const Component = mapping[name];
      const { container, unmount } = render(<Component size={16} />);
      const svgs = container.querySelectorAll("svg");
      expect(svgs, `${id}:${name}`).toHaveLength(1);
      expect(container.firstElementChild, `${id}:${name}`).toBe(svgs[0]);
      expect(svgs[0].childElementCount, `${id}:${name} draws something`).toBeGreaterThan(0);
      unmount();
    }
  });

  it("renders icons as decorative by default and as an image with a title", async () => {
    await act(() => setIconPack(id));
    const decorative = render(<CloseIcon />).container.querySelector("svg")!;
    expect(decorative.getAttribute("aria-hidden")).toBe("true");
    expect(decorative.getAttribute("focusable")).toBe("false");
    expect(decorative.getAttribute("role")).toBeNull();
    cleanup();

    const labelled = render(<CloseIcon title="Close tab" />).container.querySelector("svg")!;
    expect(labelled.getAttribute("role")).toBe("img");
    expect(labelled.getAttribute("aria-label")).toBe("Close tab");
    expect(labelled.getAttribute("aria-hidden")).toBeNull();
  });

  it("passes className and style through to the <svg>", async () => {
    await act(() => setIconPack(id));
    const svg = render(<TrashIcon className="text-danger" style={{ opacity: 0.5 }} />).container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-danger");
    expect(svg.style.opacity).toBe("0.5");
  });
});

describe("Lucide adapter", () => {
  it("defaults to 16px with a 1.5 stroke and honors an explicit stroke", () => {
    const svg = render(<SettingsIcon />).container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svgOf(getPackMapping("lucide")!.close, { stroke: 1 }).getAttribute("stroke-width")).toBe("1");
  });

  it("draws the filled names with a fill", () => {
    const lucide = getPackMapping("lucide")!;
    for (const name of ["starFilled", "pinFilled", "playerStopFilled", "circleFilled"] as const) {
      expect(markup(lucide[name]), name).toContain('fill="currentColor"');
    }
    expect(markup(lucide.star)).toContain('fill="none"');
  });
});

describe("Hugeicons adapter (spec 5.2)", () => {
  it("renders only menu-safe elements on a 24px grid, stroked in the text color with no color attribute", async () => {
    const hugeicons = await loadIconPack("hugeicons");
    for (const name of SEMANTIC_ICON_NAMES) {
      if (name === "circleFilled") continue;
      const svg = svgOf(hugeicons[name]);
      expect(svg.getAttribute("viewBox"), name).toBe("0 0 24 24");
      expect(svg.getAttribute("fill"), name).toBe("none");
      expect(svg.hasAttribute("color"), name).toBe(false);
      for (const el of svg.querySelectorAll("*")) {
        expect(MENU_SAFE_TAGS.has(el.tagName.toLowerCase()), `${name}: <${el.tagName}>`).toBe(true);
        expect(el.hasAttribute("color"), name).toBe(false);
      }
      const stroked = [...svg.querySelectorAll("[stroke]")];
      expect(stroked.length, `${name} is stroked`).toBeGreaterThan(0);
      for (const el of stroked) expect(el.getAttribute("stroke"), name).toBe("currentColor");
    }
  }, PRELOAD_TIMEOUT_MS);

  it("draws at a 1.5 stroke by default and honors an explicit stroke", async () => {
    const hugeicons = await loadIconPack("hugeicons");
    expect(HUGEICONS_STROKE_WIDTH).toBe(1.5);
    expect(svgOf(hugeicons.close).querySelector("path")!.getAttribute("stroke-width")).toBe("1.5");
    expect(svgOf(hugeicons.close, { stroke: 2 }).querySelector("path")!.getAttribute("stroke-width")).toBe("2");
    expect(svgOf(hugeicons.close, { size: 20 }).getAttribute("width")).toBe("20");
  }, PRELOAD_TIMEOUT_MS);

  it("fills the three filled names with the outline glyph, and only those", async () => {
    const hugeicons = await loadIconPack("hugeicons");
    const pairs = [["starFilled", "star"], ["pinFilled", "pin"], ["playerStopFilled", "playerStop"]] as const;
    for (const [filled, outline] of pairs) {
      const filledShapes = [...svgOf(hugeicons[filled]).querySelectorAll("path, circle, ellipse")];
      expect(filledShapes.every((el) => el.getAttribute("fill") === "currentColor"), filled).toBe(true);
      expect(filledShapes.map((el) => el.getAttribute("d"))).toEqual(
        [...svgOf(hugeicons[outline]).querySelectorAll("path, circle, ellipse")].map((el) => el.getAttribute("d")),
      );
      expect(markup(hugeicons[outline]), outline).not.toContain('fill="currentColor"');
    }
  }, PRELOAD_TIMEOUT_MS);

  it("throws on an element outside the allowlist", () => {
    const glyph: HugeiconsGlyph = [["foreignObject", { key: "0" }]];
    const Broken = wrapHugeicon(glyph, "BrokenIcon");
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    const consoleError = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Broken />)).toThrow("Hugeicons BrokenIcon: unexpected <foreignObject>");
    } finally {
      console.error = consoleError;
      window.removeEventListener("error", onError);
    }
  });
});

describe("pack details", () => {
  it("fills Phosphor's playerStopFilled", async () => {
    const phosphor = await loadIconPack("phosphor");
    expect(markup(phosphor.playerStopFilled)).not.toBe(markup(phosphor.playerStop));
  });

  it("keeps the Tabler stroke at 1.5 and honors an explicit stroke", async () => {
    const tabler = await loadIconPack("tabler");
    expect(markup(tabler.close)).toContain('stroke-width="1.5"');
    expect(markup(tabler.close, { stroke: 1 })).toContain('stroke-width="1"');
  });

  it("draws distinct Split Right and Split Down glyphs in every pack", async () => {
    for (const id of ALL_PACKS) {
      const mapping = await loadIconPack(id);
      expect(markup(mapping.splitHorizontal), id).not.toBe(markup(mapping.splitVertical));
    }
  }, PRELOAD_TIMEOUT_MS);
});

describe("state dot (circleFilled, spec 5.4)", () => {
  const DISC_16 = { viewBox: "0 0 16 16", x: [4, 12], y: [4, 12] };
  const DISC_12 = { viewBox: "0 0 12 12", x: [2, 10], y: [2, 10] };

  // A 16px icon draws an 8px disc in every pack, and the 12px compact variant the same 8px disc.
  it.each([
    ["16px", { size: 16 }, DISC_16],
    ["20px", { size: 20 }, DISC_16],
    ["12px", { size: 12 }, DISC_12],
    ["compact", { size: 16, compact: true }, DISC_12],
  ])("draws the same 8px disc in all six packs at %s", async (_label, props, disc) => {
    for (const id of ALL_PACKS) {
      const mapping = await loadIconPack(id);
      expect(extent(mapping.circleFilled, props), id).toEqual(disc);
    }
  }, PRELOAD_TIMEOUT_MS);
});

describe("Material optical size", () => {
  // Material Symbols keep a 2px padding on their 24px grid and draw smaller than the other packs in the same
  // box (a 24px star was 14px of ink against 19 to 22 elsewhere). The adapter trims the viewBox as far as it
  // can without clipping any glyph, so every Material glyph grows by the same factor.
  it("trims every glyph's viewBox by MATERIAL_TRIM on each side and clips none", async () => {
    const material = await loadIconPack("material");
    const { MATERIAL_TRIM } = await import("../packs/material");
    expect(MATERIAL_TRIM).toBeGreaterThan(1);
    const box = 24 - 2 * MATERIAL_TRIM;
    for (const name of SEMANTIC_ICON_NAMES) {
      if (name === "circleFilled") continue;
      const { viewBox, x, y } = extent(material[name], { size: 24 });
      expect(viewBox, name).toBe(`${MATERIAL_TRIM} ${MATERIAL_TRIM} ${box} ${box}`);
      expect(Math.min(x[0], y[0]), name).toBeGreaterThanOrEqual(MATERIAL_TRIM);
      expect(Math.max(x[1], y[1]), name).toBeLessThanOrEqual(24 - MATERIAL_TRIM);
    }
  }, PRELOAD_TIMEOUT_MS);

  it("keeps the state dot Lucide's 8px disc", async () => {
    const material = await loadIconPack("material");
    expect(extent(material.circleFilled, { size: 16 })).toEqual(extent(getPackMapping("lucide")!.circleFilled, { size: 16 }));
  }, PRELOAD_TIMEOUT_MS);
});

describe("index exports", () => {
  it("exports the five layout names and the registry API", () => {
    const names = [
      "MenuIcon",
      "SplitHorizontalIcon",
      "SplitVerticalIcon",
      "EllipsisIcon",
      "CircleFilledIcon",
      "Icon",
      "useIconPackStore",
      "setIconPack",
      "bootIconPack",
      "preloadAllIconPacks",
      "getPackMapping",
      "iconToSvg",
      "ICON_PACKS",
      "ICON_PACK_LICENSES",
    ];
    for (const name of names) expect(icons, name).toHaveProperty(name);
  });

  it("no longer exports the seven retired names (D-23) or the platform theme shims", () => {
    for (const name of RETIRED_NAMES) expect(SEMANTIC_ICON_NAMES as readonly string[], name).not.toContain(name);
    for (const name of [...RETIRED_EXPORTS, "THEME_ICON_DEFAULTS", "PACK_BY_ICON_THEME", "isIconTheme", "useIconThemeStore"]) {
      expect(icons, name).not.toHaveProperty(name);
    }
    expect(useIconPackStore.getState()).not.toHaveProperty("setTheme");
  });

  it("names one component per semantic name", () => {
    const components = Object.keys(icons).filter((key) => /^[A-Z]\w*Icon$/.test(key));
    expect(components).toHaveLength(117);
  });

  it("describes the six packs in picker order with the spec 5.8 descriptions", () => {
    expect(ICON_PACKS.map((pack) => [pack.id, pack.label, pack.description])).toEqual([
      ["lucide", "Lucide", "Clean line icons · ISC"],
      ["phosphor", "Phosphor", "Soft, rounded icons · MIT"],
      ["hugeicons", "Hugeicons", "Rounded line icons · MIT"],
      ["material", "Material Symbols", "Google Material icons · Apache 2.0"],
      ["fluent", "Fluent", "Windows 11 icons · MIT"],
      ["tabler", "Tabler (Classic)", "The classic Conduit icons · MIT"],
    ]);
  });

  it("carries the spec 5.9 notice of every shipped pack", () => {
    expect(icons.ICON_PACK_LICENSES.map((pack) => pack.notice)).toEqual([
      "Lucide © Lucide Icons and Contributors, licensed under ISC. Portions © Cole Bemis (Feather), licensed under MIT.",
      "Phosphor Icons © Phosphor Icons, licensed under MIT.",
      "Hugeicons Free © Hugeicons, licensed under MIT.",
      "Material Symbols © Google, licensed under Apache 2.0. Converted from SVG to React path data.",
      "Fluent UI System Icons © Microsoft Corporation, licensed under MIT.",
      "Tabler Icons © Paweł Kuna, licensed under MIT.",
    ]);
  });
});
