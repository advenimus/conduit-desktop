import { describe, it, expect, afterEach } from "vitest";
import type { ReactElement } from "react";
import { render, cleanup, act } from "@testing-library/react";
import * as icons from "..";
import {
  Icon,
  ICON_PACKS,
  SEMANTIC_ICON_NAMES,
  THEME_ICON_DEFAULTS,
  getPackMapping,
  loadIconPack,
  preloadAllIconPacks,
  setIconPack,
  useIconPackStore,
  useIconThemeStore,
  CloseIcon,
  SettingsIcon,
  TrashIcon,
  FingerprintIcon,
} from "..";
import type { IconMapping, IconPackId } from "..";
import { svgExtent } from "./svg-extent";

const LAZY_PACKS: IconPackId[] = ["lucide", "tabler", "phosphor", "fluent", "material"];
// The first import of the five lazy packs takes about 2.5 s alone and passed 5 s in a loaded full run.
const PRELOAD_TIMEOUT_MS = 30_000;
const ALL_PACKS = ICON_PACKS.map((pack) => pack.id);

function markup(Component: IconMapping[keyof IconMapping], props: Record<string, unknown> = {}): string {
  const { container, unmount } = render(<Component size={16} {...props} />);
  const html = container.innerHTML;
  unmount();
  return html;
}

afterEach(async () => {
  cleanup();
  await act(() => setIconPack("codicons"));
});

describe("preloadAllIconPacks", () => {
  it("loads the five lazy packs", async () => {
    expect(getPackMapping("codicons")).not.toBeNull();
    for (const id of LAZY_PACKS) expect(getPackMapping(id)).toBeNull();

    await act(() => preloadAllIconPacks());

    for (const id of LAZY_PACKS) expect(getPackMapping(id)).not.toBeNull();
    expect([...useIconPackStore.getState().loaded].sort()).toEqual([...ALL_PACKS].sort());
    expect(useIconPackStore.getState().pack).toBe("codicons");
  }, PRELOAD_TIMEOUT_MS);

  it("renders <Icon pack> from the named pack, not the active one", () => {
    for (const id of LAZY_PACKS) {
      const expected = markup(getPackMapping(id)!.folder);
      const { container } = render(<Icon name="folder" pack={id} size={16} />);
      expect(container.innerHTML).toBe(expected);
      expect(container.innerHTML).not.toBe(markup(getPackMapping("codicons")!.folder));
      cleanup();
    }
  });

  it("renders <Icon> without a pack from the active pack", async () => {
    await act(() => setIconPack("lucide"));
    const { container } = render(<Icon name="search" />);
    expect(container.innerHTML).toBe(markup(getPackMapping("lucide")!.search));
  });
});

describe.each(ALL_PACKS)("%s pack", (id) => {
  it("maps all 123 names and each renders exactly one <svg>", async () => {
    const mapping = await loadIconPack(id);
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

describe("Codicons adapter", () => {
  const viewBox = (element: ReactElement) => render(element).container.querySelector("svg")!.getAttribute("viewBox");

  it("defaults to 16px and draws each glyph on its own grid", () => {
    const svg = render(<CloseIcon />).container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(viewBox(<SettingsIcon />)).toBe("0 0 24 24");
  });

  it("uses the 12px compact glyph when compact is set or size is 12 or less", () => {
    expect(viewBox(<CloseIcon compact />)).toBe("0 0 12 12");
    expect(viewBox(<CloseIcon size={12} />)).toBe("0 0 12 12");
    expect(viewBox(<CloseIcon size={10} />)).toBe("0 0 12 12");
    expect(viewBox(<CloseIcon size={20} />)).toBe("0 0 16 16");
    expect(viewBox(<TrashIcon compact />)).toBe("0 0 16 16");
  });

  it("renders the Lucide fallback for names without a Codicon", () => {
    const svg = render(<FingerprintIcon />).container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("lucide");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
  });
});

describe("pack details", () => {
  it("draws Lucide's filled names with a fill", async () => {
    const lucide = await loadIconPack("lucide");
    for (const name of ["starFilled", "pinFilled", "playerStopFilled", "circleFilled"] as const) {
      expect(markup(lucide[name]), name).toContain('fill="currentColor"');
    }
    expect(markup(lucide.star)).toContain('fill="none"');
    expect(markup(lucide.close)).toContain('stroke-width="1.5"');
  });

  it("fills Phosphor's playerStopFilled and mirrors the right panel glyphs", async () => {
    const phosphor = await loadIconPack("phosphor");
    expect(markup(phosphor.playerStopFilled)).not.toBe(markup(phosphor.playerStop));
    expect(markup(phosphor.panelLeft)).not.toBe(markup(phosphor.panelLeftOff));
    expect(markup(phosphor.panelRight)).toContain('transform="scale(-1, 1)"');
    expect(markup(phosphor.panelRightOff)).toContain('transform="scale(-1, 1)"');
    expect(markup(phosphor.panelLeft)).not.toContain("transform");
  });

  it("draws distinct shown and hidden layout glyphs in every pack", async () => {
    for (const id of ALL_PACKS) {
      const mapping = await loadIconPack(id);
      expect(markup(mapping.panelLeft), id).not.toBe(markup(mapping.panelLeftOff));
      expect(markup(mapping.panelRight), id).not.toBe(markup(mapping.panelRightOff));
    }
  });

  it("keeps the Tabler stroke at 1.5 and honors an explicit stroke", async () => {
    const tabler = await loadIconPack("tabler");
    expect(markup(tabler.close)).toContain('stroke-width="1.5"');
    expect(markup(tabler.close, { stroke: 1 })).toContain('stroke-width="1"');
  });
});

function extent(Component: IconMapping[keyof IconMapping], props: Record<string, unknown>) {
  const { container, unmount } = render(<Component {...props} />);
  const result = svgExtent(container.querySelector("svg")!);
  unmount();
  return result;
}

describe("state dot (circleFilled)", () => {
  // Spec 3.6, 3.10 and 5.2: a 16px icon that draws an 8px disc in every pack, as Codicons does.
  it.each([
    ["16px", { size: 16 }],
    ["20px", { size: 20 }],
    ["12px", { size: 12 }],
    ["compact", { size: 16, compact: true }],
  ])("draws the Codicons disc in every pack at %s", async (_label, props) => {
    const codicons = extent(getPackMapping("codicons")!.circleFilled, props);
    for (const id of LAZY_PACKS) {
      const mapping = await loadIconPack(id);
      expect(extent(mapping.circleFilled, props), id).toEqual(codicons);
    }
  }, PRELOAD_TIMEOUT_MS);

  it("is an 8px disc: half of the 16px box, two thirds of the 12px compact box", () => {
    const codicons = getPackMapping("codicons")!;
    expect(extent(codicons.circleFilled, { size: 16 })).toEqual({ viewBox: "0 0 16 16", x: [4, 12], y: [4, 12] });
    expect(extent(codicons.circleFilled, { size: 12 })).toEqual({ viewBox: "0 0 12 12", x: [2, 10], y: [2, 10] });
  });
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

  it("keeps the state dot the 8px Codicons disc", async () => {
    const material = await loadIconPack("material");
    expect(extent(material.circleFilled, { size: 16 })).toEqual(extent(getPackMapping("codicons")!.circleFilled, { size: 16 }));
  }, PRELOAD_TIMEOUT_MS);
});

describe("index exports", () => {
  it("exports the 12 new named icons and the registry API", () => {
    const names = [
      "MenuIcon",
      "PanelLeftIcon",
      "PanelLeftOffIcon",
      "PanelRightIcon",
      "PanelRightOffIcon",
      "SplitHorizontalIcon",
      "SplitVerticalIcon",
      "EllipsisIcon",
      "CollapseAllIcon",
      "AccountIcon",
      "ExplorerIcon",
      "CircleFilledIcon",
      "Icon",
      "useIconPackStore",
      "setIconPack",
      "bootIconPack",
      "preloadAllIconPacks",
      "getPackMapping",
      "iconToSvg",
      "ICON_PACKS",
    ];
    for (const name of names) expect(icons, name).toHaveProperty(name);
  });

  it("describes the six packs in Settings order", () => {
    expect(ICON_PACKS.map((pack) => pack.id)).toEqual(["codicons", "lucide", "tabler", "phosphor", "fluent", "material"]);
    expect(ICON_PACKS.map((pack) => pack.label)).toEqual([
      "Codicons",
      "Lucide",
      "Tabler (Classic)",
      "Phosphor",
      "Fluent",
      "Material Symbols",
    ]);
    for (const pack of ICON_PACKS) expect(pack.description).not.toMatch(/\u2014/);
  });

  it("keeps the deprecated theme shims", async () => {
    expect(useIconThemeStore).toBe(useIconPackStore);
    expect(THEME_ICON_DEFAULTS.default).toEqual({ size: 16, strokeWidth: 1.5 });

    await act(async () => {
      await loadIconPack("macos");
    });
    expect(useIconPackStore.getState().pack).toBe("phosphor");

    await act(async () => {
      useIconThemeStore.getState().setTheme("windows");
      await loadIconPack("windows");
    });
    expect(useIconPackStore.getState().pack).toBe("fluent");

    await act(async () => {
      await loadIconPack("ubuntu");
    });
    expect(useIconPackStore.getState().pack).toBe("tabler");

    await act(async () => {
      await loadIconPack("default");
    });
    expect(useIconPackStore.getState().pack).toBe("tabler");
  });
});
