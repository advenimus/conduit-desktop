/**
 * Forced states for the gallery. Only one element can hold focus or the pointer, so the gallery copies
 * every stylesheet rule that uses :focus-visible, :focus, :focus-within, :hover or :active and swaps
 * the pseudo-class for an attribute (data-gallery-focus, data-gallery-hover, data-gallery-active).
 * The copies keep their @layer, @media and parent selectors (Tailwind's dev output nests variants),
 * so a forced ring is drawn by the real rules (spec 2.7).
 */

// An escaped colon belongs to a class name (.enabled\:hover\:bg-x), so each pattern skips a colon after a backslash.
const SWAPS: ReadonlyArray<[RegExp, string]> = [
  [/(?<!\\):focus-within/g, ":is([data-gallery-focus], :has([data-gallery-focus]))"],
  [/(?<!\\):focus-visible/g, "[data-gallery-focus]"],
  [/(?<!\\):focus(?![\w-])/g, "[data-gallery-focus]"],
  [/(?<!\\):hover(?![\w-])/g, "[data-gallery-hover]"],
  [/(?<!\\):active(?![\w-])/g, "[data-gallery-active]"],
];

const STATE = /(?<!\\):(focus-within|focus-visible|focus|hover|active)(?![\w-])/;
// A copy of `:not(:hover)` would match the forced element's neighbours, not the element.
const NEGATED_STATE = /:not\([^)]*(?<!\\):(focus|hover|active)/;

export const MIRROR_STYLE_ID = "gallery-state-mirror";

/** The parts of CSSRule the mirror reads; plain objects in tests. */
export interface RuleLike {
  selectorText?: string;
  style?: { cssText: string };
  cssRules?: ArrayLike<RuleLike>;
  conditionText?: string;
  media?: unknown;
  name?: string;
}

function mirrorSelector(selector: string): string {
  return SWAPS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), selector);
}

function wrap(text: string, contexts: ReadonlyArray<string>): string {
  return contexts.reduceRight((inner, context) => `${context} { ${inner} }`, text);
}

function groupContext(rule: RuleLike): string | null {
  // @keyframes also has a name and child rules, but no selectors to mirror.
  if (typeof (rule as { findRule?: unknown }).findRule === "function") return null;
  if (rule.media !== undefined) return `@media ${rule.conditionText ?? (rule.media as { mediaText?: string }).mediaText ?? ""}`;
  if (rule.conditionText !== undefined) return `@supports ${rule.conditionText}`;
  if (typeof rule.name === "string") return `@layer ${rule.name}`;
  return null;
}

/** Mirrored copies of the state rules in `rules`. `underState`: an enclosing selector already had a state. */
export function mirrorRules(rules: ArrayLike<RuleLike>, contexts: ReadonlyArray<string> = [], underState = false): string[] {
  const out: string[] = [];
  for (const rule of Array.from(rules)) {
    if (typeof rule.selectorText === "string") {
      const selector = rule.selectorText;
      const stated = STATE.test(selector) && !NEGATED_STATE.test(selector);
      const mirrored = stated || underState;
      if (mirrored && rule.style?.cssText) out.push(wrap(`${stated ? mirrorSelector(selector) : selector} { ${rule.style.cssText} }`, contexts));
      if (rule.cssRules && rule.cssRules.length > 0) {
        out.push(...mirrorRules(rule.cssRules, [...contexts, stated ? mirrorSelector(selector) : selector], mirrored));
      }
    } else if (rule.cssRules) {
      const context = groupContext(rule);
      if (context) out.push(...mirrorRules(rule.cssRules, [...contexts, context], underState));
    } else if (underState && rule.style?.cssText) {
      // Declarations inside a nested @media (CSSNestedDeclarations): they belong to the enclosing selector.
      out.push(wrap(rule.style.cssText, contexts));
    }
  }
  return out;
}

/** Builds the mirrored rules from the loaded stylesheets. Returns how many rules it copied. */
export function installStateMirror(doc: Document = document): number {
  const out: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet.ownerNode instanceof Element && sheet.ownerNode.id === MIRROR_STYLE_ID) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      console.warn("[gallery] Skipping a stylesheet whose rules cannot be read", error);
      continue;
    }
    out.push(...mirrorRules(rules as unknown as ArrayLike<RuleLike>));
  }
  const style = doc.getElementById(MIRROR_STYLE_ID) ?? doc.head.appendChild(Object.assign(doc.createElement("style"), { id: MIRROR_STYLE_ID }));
  style.textContent = out.join("\n");
  return out.length;
}
