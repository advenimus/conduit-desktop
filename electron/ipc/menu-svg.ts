/**
 * Allowlist sanitizer for the icon markup the renderer sends with popup menu items (spec 7.1). The menu page
 * is built as an HTML string, so an icon is re-serialized from what this parser accepted, never passed through.
 */

export const MAX_MENU_SVG_BYTES = 8 * 1024;

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect']);

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'xmlns', 'viewBox', 'width', 'height', 'd', 'fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
  'transform', 'opacity', 'fill-opacity', 'stroke-opacity',
]);

// Path data, lengths, colors and transforms need nothing else. Excluding quotes, `<`, `>`, `&`, `:` and `/`
// makes re-serialization safe and rules out external references.
const SAFE_VALUE = /^[A-Za-z0-9\s.,#%()+-]*$/;
const ELEMENT_NAME = /^[a-z][a-zA-Z]*/;
const ATTRIBUTE = /\s+([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/y;

type Attribute = readonly [name: string, value: string];

function isDangerousAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('on') || lower.includes('href') || lower === 'style';
}

/** The allowed attributes of one tag, in order, or null when the tag must be rejected. */
function parseAttributes(source: string): Attribute[] | null {
  const kept: Attribute[] = [];
  const seen = new Set<string>();
  ATTRIBUTE.lastIndex = 0;
  let end = 0;
  for (let match = ATTRIBUTE.exec(source); match; match = ATTRIBUTE.exec(source)) {
    end = ATTRIBUTE.lastIndex;
    const [, name, doubleQuoted, singleQuoted] = match;
    const value = doubleQuoted ?? singleQuoted ?? '';
    if (isDangerousAttribute(name) || seen.has(name)) return null;
    seen.add(name);
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    if (name === 'xmlns' ? value !== SVG_NAMESPACE : !SAFE_VALUE.test(value)) return null;
    kept.push([name, value]);
  }
  return source.slice(end).trim() === '' ? kept : null;
}

function openTag(name: string, attributes: readonly Attribute[]): string {
  return `<${name}${attributes.map(([key, value]) => ` ${key}="${value}"`).join('')}>`;
}

/**
 * Returns `svg` rebuilt from allowlisted elements and attributes, or null when it holds anything else: another
 * element, text, a comment, an event handler, a link, a style, an unsafe value, or more than 8 KB.
 */
export function sanitizeSvg(svg: unknown): string | null {
  if (typeof svg !== 'string' || Buffer.byteLength(svg, 'utf8') > MAX_MENU_SVG_BYTES) return null;

  const open: string[] = [];
  let out = '';
  let rootClosed = false;
  let pos = 0;

  while (pos < svg.length) {
    const lt = svg.indexOf('<', pos);
    const text = svg.slice(pos, lt === -1 ? svg.length : lt);
    if (text.trim() !== '') return null;
    if (lt === -1) break;
    const gt = svg.indexOf('>', lt);
    if (gt === -1) return null;
    const body = svg.slice(lt + 1, gt);
    pos = gt + 1;

    if (body.startsWith('/')) {
      if (open.pop() !== body.slice(1).trim()) return null;
      out += `</${body.slice(1).trim()}>`;
      rootClosed = open.length === 0;
      continue;
    }

    if (rootClosed) return null;
    const selfClosing = body.endsWith('/');
    const tag = selfClosing ? body.slice(0, -1) : body;
    const name = ELEMENT_NAME.exec(tag)?.[0];
    if (!name || !ALLOWED_ELEMENTS.has(name) || (open.length === 0 && name !== 'svg')) return null;
    const attributes = parseAttributes(tag.slice(name.length));
    if (!attributes) return null;
    out += openTag(name, attributes);
    if (selfClosing) {
      out += `</${name}>`;
      rootClosed = open.length === 0;
    } else {
      open.push(name);
    }
  }

  return rootClosed && open.length === 0 ? out : null;
}
