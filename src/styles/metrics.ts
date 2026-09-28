/**
 * TypeScript mirror of the numeric layout tokens in tokens.css and density.css (spec 2.5, 2.9), in CSS px
 * at ui_scale 1. src/styles/__tests__/metrics.test.ts keeps both sides equal.
 */

export type Density = "comfortable" | "compact";

export const LAYOUT = Object.freeze({
  titlebarHeight: 35,
  trafficReserve: 70,
  wcoReserveStart: 0,
  wcoReserveEnd: 138,
  commandCenterHeight: 22,
  commandCenterMaxWidth: 600,
  bannerHeight: 26,
  partTitleHeight: 32,
  sectionHeight: 28,
  statusbarHeight: 22,
  activityItem: 36,
  activityPill: 32,
  controlHeightSm: 22,
  controlHeight: 26,
  controlHeightLg: 32,
  rowHeight: 22,
  rowHeight2Line: 36,
  toolbarButton: 22,
});

export interface DensityMetrics {
  gap: number;
  outer: number;
  cardRadius: number;
  cardBorderWidth: number;
  activitybarLane: number;
  activitybarWidth: number;
  activityGap: number;
  tabstripHeight: number;
  tabHeight: number;
  tabGutterTop: number;
  statusbarGutter: number;
  listInset: number;
}

export const DENSITY_METRICS: Readonly<Record<Density, Readonly<DensityMetrics>>> = Object.freeze({
  comfortable: Object.freeze({
    gap: 4,
    outer: 4,
    cardRadius: 8,
    cardBorderWidth: 1,
    activitybarLane: 8,
    activitybarWidth: 44,
    activityGap: 8,
    tabstripHeight: 33,
    tabHeight: 24,
    tabGutterTop: 4,
    statusbarGutter: 6,
    listInset: 4,
  }),
  compact: Object.freeze({
    gap: 0,
    outer: 0,
    cardRadius: 0,
    cardBorderWidth: 0,
    activitybarLane: 4,
    activitybarWidth: 40,
    activityGap: 4,
    tabstripHeight: 29,
    tabHeight: 20,
    tabGutterTop: 4,
    statusbarGutter: 4,
    listInset: 2,
  }),
});

/** Every sash is 4px in the layout flow: the gap between cards in Comfortable, its own element in Compact. */
export const SASH_SIZE = 4;

/** Width the workbench chrome takes beside a docked side bar (spec 3.3): 56 Comfortable, 44 Compact. */
export function chromeWidth(density: Density): number {
  const d = DENSITY_METRICS[density];
  return 2 * d.outer + d.activitybarWidth + SASH_SIZE;
}

/** Status bar plus its bottom gutter (spec 3.10): 28 Comfortable, 26 Compact. */
export function statusBarHeight(density: Density): number {
  return LAYOUT.statusbarHeight + DENSITY_METRICS[density].statusbarGutter;
}
