export type Point = readonly [number, number];

const PATH_TOKEN = /[MLHVCSQTAZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const PARAMS_PER_COMMAND: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function isSwept(angle: number, start: number, sweep: number): boolean {
  const turn = 2 * Math.PI;
  const offset = (((angle - start) * Math.sign(sweep)) % turn + turn) % turn;
  return offset <= Math.abs(sweep) + 1e-9;
}

// SVG 1.1 F.6.5 (endpoint to center), then the axis extremes the arc passes. Rotated arcs are not needed here.
function arcExtremes(from: Point, to: Point, args: ReadonlyArray<number>): Point[] {
  const [rxIn, ryIn, rotation, largeArc, sweepFlag] = args;
  if (rotation % 180 !== 0) throw new Error(`rotated arcs are not supported (${rotation})`);
  const [x1, y1] = from;
  const [x2, y2] = to;
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  const scale = Math.max(1, Math.sqrt((hx * hx) / (rxIn * rxIn) + (hy * hy) / (ryIn * ryIn)));
  const [rx, ry] = [rxIn * scale, ryIn * scale];
  const numerator = rx * rx * ry * ry - rx * rx * hy * hy - ry * ry * hx * hx;
  const denominator = rx * rx * hy * hy + ry * ry * hx * hx;
  const coef = (largeArc !== sweepFlag ? 1 : -1) * Math.sqrt(Math.max(0, numerator / denominator));
  const [ocx, ocy] = [(coef * rx * hy) / ry, (-coef * ry * hx) / rx];
  const [cx, cy] = [ocx + (x1 + x2) / 2, ocy + (y1 + y2) / 2];
  const start = Math.atan2((hy - ocy) / ry, (hx - ocx) / rx);
  const end = Math.atan2((-hy - ocy) / ry, (-hx - ocx) / rx);
  let sweep = end - start;
  if (sweepFlag === 0 && sweep > 0) sweep -= 2 * Math.PI;
  if (sweepFlag === 1 && sweep < 0) sweep += 2 * Math.PI;
  return [0, 0.5, 1, 1.5]
    .map((quarter) => quarter * Math.PI)
    .filter((angle) => isSwept(angle, start, sweep))
    .map((angle): Point => [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
}

/**
 * Segment end points of a path, plus the extremes of its arcs. Curve control
 * points are ignored, so a curved outline must pass through its extremes.
 */
export function pathPoints(d: string): Point[] {
  const tokens = d.match(PATH_TOKEN) ?? [];
  const points: Point[] = [];
  let current: Point = [0, 0];
  let subpathStart: Point = [0, 0];
  let command = "";
  let i = 0;
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) command = tokens[i++];
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const count = PARAMS_PER_COMMAND[upper];
    if (count === undefined) throw new Error(`unknown path command ${command}`);
    const args = tokens.slice(i, i + count).map(Number);
    i += count;
    const [x, y] = current;
    let next: Point;
    if (upper === "Z") next = subpathStart;
    else if (upper === "H") next = [relative ? x + args[0] : args[0], y];
    else if (upper === "V") next = [x, relative ? y + args[0] : args[0]];
    else next = relative ? [x + args[count - 2], y + args[count - 1]] : [args[count - 2], args[count - 1]];
    if (upper === "A") points.push(...arcExtremes(current, next, args));
    if (upper === "M") {
      subpathStart = next;
      command = relative ? "l" : "L";
    }
    points.push(next);
    current = next;
  }
  return points;
}

export interface SvgExtent {
  viewBox: string | null;
  x: readonly [number, number];
  y: readonly [number, number];
}

/** The drawn extent of the paths and circles in an <svg>, in viewBox units, to 0.01. */
export function svgExtent(svg: SVGSVGElement): SvgExtent {
  const points: Point[] = [
    ...[...svg.querySelectorAll("path")].flatMap((path) => pathPoints(path.getAttribute("d") ?? "")),
    ...[...svg.querySelectorAll("circle")].flatMap((circle): Point[] => {
      const [cx, cy, r] = ["cx", "cy", "r"].map((name) => Number(circle.getAttribute(name)));
      return [[cx - r, cy - r], [cx + r, cy + r]];
    }),
  ];
  if (points.length === 0) throw new Error("the svg draws no path or circle");
  const round = (value: number) => Math.round(value * 100) / 100 + 0;
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return {
    viewBox: svg.getAttribute("viewBox"),
    x: [round(Math.min(...xs)), round(Math.max(...xs))],
    y: [round(Math.min(...ys)), round(Math.max(...ys))],
  };
}
