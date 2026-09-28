// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_MENU_SVG_BYTES, sanitizeSvg } from '../menu-svg.js';

const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe('sanitizeSvg', () => {
  it('keeps the allowed elements and attributes of a stroke icon (Lucide, Tabler)', () => {
    const input =
      `<svg ${NS} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
      '<path d="M18 6 6 18"></path><circle cx="12" cy="12" r="3"></circle><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>' +
      '<line x1="1" y1="2" x2="3" y2="4"></line><polyline points="15 4 20 4 20 9"></polyline><polygon points="5 3 19 12 5 21"></polygon>' +
      '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse></svg>';
    expect(sanitizeSvg(input)).toBe(
      `<svg ${NS} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
        '<path d="M18 6 6 18"></path><circle cx="12" cy="12" r="3"></circle><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect>' +
        '<line x1="1" y1="2" x2="3" y2="4"></line><polyline points="15 4 20 4 20 9"></polyline><polygon points="5 3 19 12 5 21"></polygon>' +
        '<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse></svg>',
    );
  });

  it('keeps transform on the root <svg> for mirrored Phosphor glyphs', () => {
    const input = `<svg ${NS} width="16" height="16" fill="currentColor" viewBox="0 0 256 256" transform="scale(-1, 1)" aria-hidden="true" focusable="false"><path d="M216,40H40Z"></path></svg>`;
    expect(sanitizeSvg(input)).toBe(`<svg ${NS} width="16" height="16" fill="currentColor" viewBox="0 0 256 256" transform="scale(-1, 1)"><path d="M216,40H40Z"></path></svg>`);
  });

  it('keeps fill rules, opacities and groups (Codicons, Material)', () => {
    const input =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><g opacity=".5" fill-opacity="1" stroke-opacity="0.2">' +
      '<path fill-rule="evenodd" clip-rule="evenodd" d="M1 1h14v14H1z"></path></g></svg>';
    expect(sanitizeSvg(input)).toBe(input);
  });

  it('drops attributes outside the allowlist', () => {
    const input = `<svg ${NS} class="lucide" data-x="1" aria-label="x" role="img" viewBox="0 0 16 16"><path id="p" d="M0 0h1"></path></svg>`;
    expect(sanitizeSvg(input)).toBe(`<svg ${NS} viewBox="0 0 16 16"><path d="M0 0h1"></path></svg>`);
  });

  it('writes self-closing elements as open and close tags and ignores whitespace between tags', () => {
    expect(sanitizeSvg(`<svg ${NS}>\n  <path d="M0 0h1"/>\n  <circle r="1" />\n</svg>`)).toBe(`<svg ${NS}><path d="M0 0h1"></path><circle r="1"></circle></svg>`);
  });

  it.each([
    ['a script element', `<svg ${NS}><script>alert(1)</script></svg>`],
    ['a script element with no body', `<svg ${NS}><script/></svg>`],
    ['foreignObject', `<svg ${NS}><foreignObject><div></div></foreignObject></svg>`],
    ['use', `<svg ${NS}><use href="#a"></use></svg>`],
    ['image', `<svg ${NS}><image width="1"></image></svg>`],
    ['a style element', `<svg ${NS}><style>*{}</style></svg>`],
    ['an animation element', `<svg ${NS}><path d="M0 0"><set attributeName="d" to="M1 1"></set></path></svg>`],
    ['text content', `<svg ${NS}>hello</svg>`],
    ['a text element', `<svg ${NS}><text>hi</text></svg>`],
    ['an HTML root', '<div><svg></svg></div>'],
    ['a root that is not svg', '<path d="M0 0"></path>'],
    ['a comment', `<svg ${NS}><!-- x --></svg>`],
    ['CDATA', `<svg ${NS}><![CDATA[x]]></svg>`],
    ['a doctype', `<!DOCTYPE svg><svg ${NS}></svg>`],
    ['an XML declaration', `<?xml version="1.0"?><svg ${NS}></svg>`],
    ['two roots', `<svg ${NS}></svg><svg ${NS}></svg>`],
    ['text after the root', `<svg ${NS}></svg>x`],
    ['an unclosed element', `<svg ${NS}><path d="M0 0">`],
    ['a mismatched close tag', `<svg ${NS}><g></path></svg>`],
    ['a stray close tag', `</svg>`],
    ['an unterminated tag', `<svg ${NS}`],
    ['an unquoted attribute value', '<svg width=16></svg>'],
    ['an uppercase element name', '<SVG></SVG>'],
  ])('rejects %s', (_label, input) => {
    expect(sanitizeSvg(input)).toBeNull();
  });

  it.each([
    ['onload', `<svg ${NS} onload="alert(1)"></svg>`],
    ['onclick on a child', `<svg ${NS}><path onclick="alert(1)" d="M0 0"></path></svg>`],
    ['an uppercase handler', `<svg ${NS}><path ONMOUSEOVER="x" d="M0 0"></path></svg>`],
    ['href', `<svg ${NS}><path href="#x" d="M0 0"></path></svg>`],
    ['xlink:href', `<svg ${NS}><g xlink:href="javascript:alert(1)"></g></svg>`],
    ['style', `<svg ${NS} style="color:red"></svg>`],
    ['a STYLE attribute', `<svg ${NS}><path STYLE="x" d="M0 0"></path></svg>`],
  ])('rejects the %s attribute', (_label, input) => {
    expect(sanitizeSvg(input)).toBeNull();
  });

  it.each([
    ['a quote', `<svg ${NS}><path d='M0 0" onclick="x'></path></svg>`],
    ['a tag', `<svg ${NS}><path d="M0 0<script>"></path></svg>`],
    ['an entity', `<svg ${NS}><path d="M0 0&quot;"></path></svg>`],
    ['a url', `<svg ${NS}><path fill="url(http://example.test/x.svg#a)" d="M0 0"></path></svg>`],
    ['a javascript url', `<svg ${NS}><path fill="javascript:alert(1)" d="M0 0"></path></svg>`],
    ['a foreign namespace', '<svg xmlns="http://www.w3.org/1999/xhtml"></svg>'],
  ])('rejects an attribute value with %s', (_label, input) => {
    expect(sanitizeSvg(input)).toBeNull();
  });

  it('rejects a repeated attribute', () => {
    expect(sanitizeSvg(`<svg ${NS}><path d="M0 0" d="M1 1"></path></svg>`)).toBeNull();
  });

  it('rejects markup over 8 KB and accepts markup at the limit', () => {
    const shell = (d: string) => `<svg ${NS}><path d="${d}"></path></svg>`;
    const overhead = shell('').length;
    const atLimit = shell('M'.padEnd(MAX_MENU_SVG_BYTES - overhead, '0'));
    expect(MAX_MENU_SVG_BYTES).toBe(8 * 1024);
    expect(atLimit.length).toBe(MAX_MENU_SVG_BYTES);
    expect(sanitizeSvg(atLimit)).toBe(atLimit);
    expect(sanitizeSvg(shell('M'.padEnd(MAX_MENU_SVG_BYTES - overhead + 1, '0')))).toBeNull();
  });

  it('rejects anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}, ['<svg></svg>']]) expect(sanitizeSvg(value)).toBeNull();
  });
});
