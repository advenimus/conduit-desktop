// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./cssTokens";
import { DENSITY_METRICS, LAYOUT, SASH_SIZE, chromeWidth, statusBarHeight, type DensityMetrics } from "../metrics";

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No "${selector}" block`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const decls = new Map<string, string>();
  for (const m of body.matchAll(/(--c-[\w-]+):\s*([^;]+);/g)) decls.set(m[1], m[2].trim());
  return decls;
}

function px(value: string | undefined): number {
  if (value === undefined) throw new Error("missing token");
  if (value === "0") return 0;
  const m = value.match(/^(-?[\d.]+)px$/);
  if (!m) throw new Error(`Not a px value: ${value}`);
  return Number(m[1]);
}

const LAYOUT_TOKENS: Record<keyof typeof LAYOUT, string> = {
  titlebarHeight: "--c-titlebar-h",
  trafficReserve: "--c-traffic-reserve",
  wcoReserveStart: "--c-wco-reserve-start",
  wcoReserveEnd: "--c-wco-reserve-end",
  commandCenterHeight: "--c-cc-h",
  commandCenterMaxWidth: "--c-cc-max-w",
  bannerHeight: "--c-banner-h",
  partTitleHeight: "--c-part-title-h",
  sectionHeight: "--c-section-h",
  statusbarHeight: "--c-statusbar-h",
  activityItem: "--c-activity-item",
  activityPill: "--c-activity-pill",
  controlHeightSm: "--c-control-h-sm",
  controlHeight: "--c-control-h",
  controlHeightLg: "--c-control-h-lg",
  rowHeight: "--c-row-h",
  rowHeight2Line: "--c-row-h-2line",
  toolbarButton: "--c-toolbar-btn",
};

const DENSITY_TOKENS: Record<keyof DensityMetrics, string> = {
  gap: "--c-gap",
  outer: "--c-outer",
  cardRadius: "--c-card-radius",
  cardBorderWidth: "--c-card-border-w",
  activitybarLane: "--c-activitybar-lane",
  activitybarWidth: "--c-activitybar-w",
  activityGap: "--c-activity-gap",
  tabstripHeight: "--c-tabstrip-h",
  tabHeight: "--c-tab-h",
  tabGutterTop: "--c-tab-gutter-top",
  statusbarGutter: "--c-statusbar-gutter",
  listInset: "--c-list-inset",
};

describe("metrics.ts mirrors the layout tokens (spec 2.5)", () => {
  it("layout sizes equal tokens.css", () => {
    const root = block(readRepoFile("src", "styles", "tokens.css"), ":root");
    for (const [key, token] of Object.entries(LAYOUT_TOKENS)) {
      expect(LAYOUT[key as keyof typeof LAYOUT], token).toBe(px(root.get(token)));
    }
  });

  it("density sizes equal density.css", () => {
    const css = readRepoFile("src", "styles", "density.css");
    const blocks = { comfortable: block(css, ":root"), compact: block(css, ':root[data-density="compact"]') };
    for (const density of ["comfortable", "compact"] as const) {
      for (const [key, token] of Object.entries(DENSITY_TOKENS)) {
        expect(DENSITY_METRICS[density][key as keyof DensityMetrics], `${density} ${token}`).toBe(px(blocks[density].get(token)));
      }
    }
  });

  it("derives the chrome width and status bar height of spec 3.3 and 3.10", () => {
    expect(SASH_SIZE).toBe(4);
    expect(chromeWidth("comfortable")).toBe(56);
    expect(chromeWidth("compact")).toBe(44);
    expect(statusBarHeight("comfortable")).toBe(28);
    expect(statusBarHeight("compact")).toBe(26);
  });
});
