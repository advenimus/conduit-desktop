// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import type { Root } from "postcss";
import {
  TokenResolver,
  cascade,
  compileIndexCss,
  composite,
  contrast,
  matchRoot,
  parseColorLiteral,
  readRepoFile,
  toHex,
  tokenRules,
  type Rgba,
  type RootState,
  type TokenRule,
} from "./cssTokens";
import { COLOR_TOKENS, LAYOUT_TOKENS, MODERN_VALUES, MODES, REMOVED_TOKENS, SCHEME_IDS, UNIVERSAL_SURFACES } from "./tokenContract";
import { COLOR_SCHEMES } from "../../lib/schemes";

const SCHEME_SELECTOR = /^:root\[data-scheme="(modern|ocean|ember|forest|amethyst|rose|midnight)"\]\.(dark|light)$/;
const MODERN_FALLBACK = new Set([":root:not([data-scheme]).dark", ":root:not([data-scheme]).light"]);
const MODE_BASE = new Set([":root", ":root.dark", ":root.light"]);
const OS_SELECTOR = /^:root\[data-os="(macos|windows|linux)"\]$/;
const RESCOPE_SELECTOR =
  ':where([role="option"][aria-selected="true"], [role="treeitem"][aria-selected="true"], [role="row"][aria-selected="true"], [role="gridcell"][aria-selected="true"], [data-selected])';
const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
const COMBOS = SCHEME_IDS.flatMap((scheme) => MODES.map((mode) => ({ scheme, mode })));

let root: Root;
let rules: TokenRule[];

function resolverFor(state: RootState): TokenResolver {
  return new TokenResolver(cascade(rules, state));
}

beforeAll(async () => {
  root = await compileIndexCss();
  rules = tokenRules(root);
}, 60_000);

describe("token cascade (spec 2.1)", () => {
  it("1. no selector mentions data-platform or data-density", () => {
    const offenders: string[] = [];
    root.walkRules((rule) => {
      if (/data-(platform|density)/.test(rule.selector)) offenders.push(rule.selector);
    });
    expect(offenders).toEqual([]);
  });

  it("2. scheme color tokens live only in :root[data-scheme].dark/.light blocks", () => {
    for (const rule of rules) {
      for (const part of rule.parts) {
        if (!part.includes("data-scheme")) continue;
        expect(SCHEME_SELECTOR.test(part) || MODERN_FALLBACK.has(part), `${part}`).toBe(true);
      }
    }
    const declaringModern = rules.filter((r) => r.parts.some((p) => MODERN_FALLBACK.has(p)));
    expect(declaringModern.length).toBeGreaterThanOrEqual(2);
  });

  it("every --c-* declaration sits in a layer the model knows, outside any @layer", () => {
    for (const rule of rules) {
      expect(rule.inLayer, rule.selector).toBeNull();
      if (rule.inMedia !== null) {
        expect(rule.inMedia).toBe("(prefers-reduced-motion: reduce)");
        expect([...rule.decls.keys()].every((p) => p.startsWith("--c-motion-"))).toBe(true);
        continue;
      }
      if (rule.selector === RESCOPE_SELECTOR) continue;
      for (const part of rule.parts) {
        const known = MODE_BASE.has(part) || SCHEME_SELECTOR.test(part) || MODERN_FALLBACK.has(part) || OS_SELECTOR.test(part);
        expect(known, `unexpected token selector ${part}`).toBe(true);
      }
    }
  });

  it("OS rules only set font stacks", () => {
    for (const rule of rules.filter((r) => r.parts.some((p) => OS_SELECTOR.test(p)))) {
      expect([...rule.decls.keys()].every((p) => p.startsWith("--c-font-"))).toBe(true);
    }
  });

  it("3. the layout sizes are plain :root tokens with one value each (D-7)", () => {
    const setters = rules.filter((r) => Object.keys(LAYOUT_TOKENS).some((t) => r.decls.has(t)));
    expect(setters.map((r) => r.selector)).toEqual([":root"]);
    for (const [token, value] of Object.entries(LAYOUT_TOKENS)) expect(setters[0].decls.get(token), token).toBe(value);
  });

  it("5. none of the removed tokens (spec 9.1) is defined anywhere", () => {
    const defined = new Set<string>();
    root.walkDecls((decl) => {
      if (decl.prop.startsWith("--c-")) defined.add(decl.prop);
    });
    expect(REMOVED_TOKENS.filter((token) => defined.has(token))).toEqual([]);
  });

  it("the @theme block drops the removed sizes and the compact variant", () => {
    const index = readRepoFile("src", "index.css");
    for (const gone of ["--radius-card", "--spacing-titlebar", "--spacing-statusbar", "--spacing-activitybar", "@custom-variant compact", "density.css", "cards.css"]) {
      expect(index, gone).not.toContain(gone);
    }
    expect(index).toContain("--color-favorite: var(--c-favorite);");
  });

  it("the selector model covers every token selector", () => {
    for (const rule of rules) {
      if (rule.selector === RESCOPE_SELECTOR) continue;
      for (const part of rule.parts) expect(matchRoot(part, { mode: "dark", scheme: "ocean" }), part).not.toBeNull();
    }
  });

  it.each(COMBOS)("4. every contract token resolves to a color: $scheme $mode", ({ scheme, mode }) => {
    const resolver = resolverFor({ scheme, mode });
    const missing = COLOR_TOKENS.filter((token) => {
      try {
        resolver.color(token);
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  it("a missing data-scheme resolves exactly like data-scheme=modern", () => {
    for (const mode of MODES) {
      const explicit = resolverFor({ scheme: "modern", mode });
      const implicit = resolverFor({ mode });
      for (const token of COLOR_TOKENS) expect(toHex(implicit.color(token)), token).toBe(toHex(explicit.color(token)));
    }
  });

  it("Modern resolves to the exact values of spec 2.2", () => {
    MODES.forEach((mode, index) => {
      const resolver = resolverFor({ scheme: "modern", mode });
      for (const [token, values] of Object.entries(MODERN_VALUES)) {
        expect(toHex(resolver.color(token)), `${mode} ${token}`).toBe(toHex(parseColorLiteral(values[index])));
      }
    });
  });

  it.each(Object.keys(UNIVERSAL_SURFACES))("the universal scheme %s matches the derived surfaces of spec 2.3", (scheme) => {
    for (const mode of MODES) {
      const r = resolverFor({ scheme, mode });
      const shell = r.color("--c-shell");
      const actual = [shell, r.color("--c-editor"), r.color("--c-tabstrip"), r.color("--c-overlay"), composite(r.color("--c-hover"), shell), composite(r.color("--c-selected"), shell)];
      UNIVERSAL_SURFACES[scheme][mode].forEach((expected, i) => {
        const want = parseColorLiteral(expected);
        const got = actual[i];
        for (const ch of ["r", "g", "b"] as const) expect(Math.abs(got[ch] - want[ch]) * 255, `${scheme} ${mode} #${i}: ${toHex(got)} vs ${expected}`).toBeLessThanOrEqual(1);
      });
    }
  });

});

interface Gate {
  label: string;
  fg: Rgba;
  bg: Rgba;
  min: number;
}

function gatesFor(r: TokenResolver): Gate[] {
  const c = (t: string) => r.color(`--c-${t}`);
  const gates: Gate[] = [];
  const add = (label: string, fg: Rgba, bg: Rgba, min: number) => gates.push({ label, fg, bg, min });
  const surfaces = ["shell", "editor", "overlay"];

  // 1. text on the three main surfaces
  for (const text of ["ink", "ink-secondary", "ink-muted", "ink-faint", "accent-text", "danger", "warning", "success", "info"]) {
    for (const s of surfaces) add(`${text} on ${s}`, c(text), c(s), 4.5);
  }
  // 2. chrome text on its own surface
  add("tab-fg on tabstrip", c("tab-fg"), c("tabstrip"), 4.5);
  add("tab-fg-active on tab-active-bg", c("tab-fg-active"), c("tab-active-bg"), 4.5);
  add("tab-fg-hover on tab-hover-bg", c("tab-fg-hover"), c("tab-hover-bg"), 4.5);
  // 3. tone text on its own tint
  add("danger on danger-bg", c("danger"), c("danger-bg"), 4.5);
  add("warning on warning-bg", c("warning"), c("warning-bg"), 4.5);
  add("success on success-bg", c("success"), c("success-bg"), 4.5);
  add("info on info-bg", c("info"), c("info-bg"), 3);
  // 4. text inside a selected row
  const selectedRow = composite(c("selected"), c("sidebar"));
  add("ink on selected", c("ink"), selectedRow, 4.5);
  add("ink-secondary on selected", c("ink-secondary"), selectedRow, 4.5);
  // ...and on selected-inactive: unfocused list rows and the checked ChoiceCard (in a dialog or the side bar)
  for (const s of ["overlay", "sidebar"]) {
    const inactiveRow = composite(c("selected-inactive"), c(s));
    add(`ink on selected-inactive over ${s}`, c("ink"), inactiveRow, 4.5);
    add(`ink-secondary on selected-inactive over ${s}`, c("ink-secondary"), inactiveRow, 4.5);
  }
  // 4b. text on inner surfaces: cards, inputs and segmented controls (well), and the active menu item
  for (const s of ["shell", "editor", "overlay", "sidebar"]) {
    const well = composite(c("well"), c(s));
    add(`ink-muted on well over ${s}`, c("ink-muted"), well, 4.5);
    add(`ink-faint on well over ${s}`, c("ink-faint"), well, 4.5);
  }
  const menuActive = composite(c("menu-selection-bg"), c("overlay"));
  add("ink-secondary on menu-selection-bg", c("ink-secondary"), menuActive, 4.5);
  add("ink-muted (menu icons) on menu-selection-bg", c("ink-muted"), menuActive, 3);
  add("danger on menu-danger-hover-bg", c("danger"), composite(c("menu-danger-hover-bg"), c("overlay")), 4.5);
  // 5. white on filled buttons and badges
  for (const bg of ["btn-primary-bg", "btn-primary-hover", "badge-bg", "btn-danger-bg", "btn-danger-hover"]) add(`white on ${bg}`, WHITE, c(bg), 4.5);
  // 6. non-text
  for (const s of surfaces) {
    add(`focus on ${s}`, c("focus"), c(s), 3);
    add(`checkbox-border on ${s}`, c("checkbox-border"), c(s), 3);
  }
  add("checkbox-border on checkbox-bg", c("checkbox-border"), composite(c("checkbox-bg"), c("overlay")), 3);
  // Roving controls (Tabs, NavList, SegmentedControl, ListRow) put the focus ring on the selected item.
  for (const s of ["overlay", "sidebar"]) {
    add(`focus on selected over ${s}`, c("focus"), composite(c("selected"), c(s)), 3);
    add(`focus on selected-inactive over ${s}`, c("focus"), composite(c("selected-inactive"), c(s)), 3);
  }
  add("focus on selected over well (SegmentedControl)", c("focus"), composite(c("selected"), composite(c("well"), c("overlay"))), 3);
  for (const state of ["state-connected", "state-connecting", "state-error"]) {
    for (const s of ["shell", "tabstrip", "tab-active-bg"]) add(`${state} on ${s}`, c(state), c(s), 3);
  }
  for (const entry of ["ssh", "rdp", "vnc", "web", "credential", "document", "command", "folder"]) {
    for (const s of ["sidebar", "editor", "tabstrip"]) add(`entry-${entry} on ${s}`, c(`entry-${entry}`), c(s), 3);
  }
  // The favorite star in the side bar header and the tree (D-17)
  add("favorite on sidebar", c("favorite"), c("sidebar"), 3);
  add("favorite on selected over sidebar", c("favorite"), selectedRow, 3);
  return gates;
}

describe("contrast gates (spec 2.10)", () => {
  it.each(COMBOS)("$scheme $mode passes every gate", ({ scheme, mode }) => {
    const failures = gatesFor(resolverFor({ scheme, mode }))
      .map((g) => ({ ...g, ratio: contrast(g.fg, g.bg) }))
      .filter((g) => g.ratio < g.min)
      .map((g) => `${g.label}: ${g.ratio.toFixed(2)} < ${g.min}`);
    expect(failures).toEqual([]);
  });

  it("7. ink-disabled is exempt but still declared", () => {
    for (const { scheme, mode } of COMBOS) expect(resolverFor({ scheme, mode }).has("--c-ink-disabled")).toBe(true);
  });

  it("new faint text is AA in every scheme (was 2.2 to 3.3:1)", () => {
    for (const { scheme, mode } of COMBOS) {
      const r = resolverFor({ scheme, mode });
      for (const s of ["--c-shell", "--c-editor", "--c-overlay"]) expect(contrast(r.color("--c-ink-faint"), r.color(s))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("selected-row re-scope (spec 2.11)", () => {
  it("redeclares both the --c-* tokens and the --color-* theme variables", () => {
    let decls: Record<string, string> | null = null;
    root.walkRules((rule) => {
      if (rule.selector !== RESCOPE_SELECTOR) return;
      decls = {};
      rule.walkDecls((d) => {
        decls![d.prop] = d.value;
      });
    });
    expect(decls).toEqual({
      "--c-ink-muted": "var(--c-ink-secondary)",
      "--color-ink-muted": "var(--c-ink-secondary)",
      "--c-ink-faint": "var(--c-ink-secondary)",
      "--color-ink-faint": "var(--c-ink-secondary)",
      "--c-accent-text": "var(--c-ink)",
      "--color-link": "var(--c-ink)",
      "--c-accent-text-hover": "var(--c-ink)",
      "--color-link-hover": "var(--c-ink)",
    });
  });

  it("Tailwind reads ink-muted, ink-faint and link through the --color-* variables", () => {
    const css = root.toString();
    expect(css).toMatch(/\.text-ink-muted\s*\{\s*color:\s*var\(--color-ink-muted\)/);
    expect(css).toMatch(/\.text-ink-faint\s*\{\s*color:\s*var\(--color-ink-faint\)/);
  });
});

describe("@theme mapping (spec 2.10)", () => {
  it("entry-type colors compile to tokens (entryIcons.ts uses them)", () => {
    const css = root.toString();
    for (const entry of ["ssh", "rdp", "vnc", "web", "credential", "document", "command", "folder"]) {
      expect(css).toMatch(new RegExp(`\\.text-entry-${entry}\\s*\\{\\s*color:\\s*var\\(--color-entry-${entry}\\)`));
      expect(css).toContain(`--color-entry-${entry}: var(--c-entry-${entry});`);
    }
  });

  it("legacy sizes and radii follow the tokens", () => {
    const css = root.toString();
    expect(css).toContain("--text-sm: var(--c-text-body);");
    expect(css).toContain("--radius: var(--c-radius-sm);");
    expect(css).toMatch(/\.rounded\s*\{\s*border-radius:\s*var\(--radius\)/);
    expect(css).toContain("--font-weight-medium: 600;");
  });
});

describe("scheme metadata and shell colors follow the resolved tokens", () => {
  const shellColors = JSON.parse(readRepoFile("src", "lib", "appearance", "shell-colors.json")) as Record<string, Record<string, { shell: string; fg: string }>>;

  it("COLOR_SCHEMES lists the 7 schemes, Modern first", () => {
    expect(COLOR_SCHEMES.map((s) => s.id)).toEqual([...SCHEME_IDS]);
  });

  it.each(COMBOS)("$scheme $mode preview and shell-colors.json", ({ scheme, mode }) => {
    const r = resolverFor({ scheme, mode });
    const hex = (t: string) => toHex(r.color(t));
    const preview = COLOR_SCHEMES.find((s) => s.id === scheme)!.preview[mode];
    expect({
      shell: toHex(parseColorLiteral(preview.shell)),
      editor: toHex(parseColorLiteral(preview.editor)),
      sidebar: toHex(parseColorLiteral(preview.sidebar)),
      accent: toHex(parseColorLiteral(preview.accent)),
    }).toEqual({ shell: hex("--c-shell"), editor: hex("--c-editor"), sidebar: hex("--c-sidebar"), accent: hex("--c-accent") });
    const boot = shellColors[scheme][mode];
    expect({ shell: toHex(parseColorLiteral(boot.shell)), fg: toHex(parseColorLiteral(boot.fg)) }).toEqual({ shell: hex("--c-shell"), fg: hex("--c-ink-faint") });
  });

  it("shell-colors.json has exactly the 7 schemes", () => {
    expect(Object.keys(shellColors).sort()).toEqual([...SCHEME_IDS].sort());
  });
});

describe("global rules (spec 2.7, 2.8)", () => {
  const base = readRepoFile("src", "styles", "base.css");

  it("focus ring is inset by default and 2px outside for text buttons, checkboxes, radios and choice cards", () => {
    expect(base).toMatch(/:where\(button,[^{]*\[tabindex\],[^{]*input:not\(\[data-bare\]\), select, textarea\):focus-visible\s*\{\s*outline: 1px solid var\(--c-focus\);\s*outline-offset: -1px;/s);
    expect(base).toMatch(/:where\(\[data-cv-text-button\], input\[type="checkbox"\], input\[type="radio"\], \[data-cv-choice\]\):focus-visible\s*\{\s*outline-offset: 2px;/s);
    expect(base).not.toMatch(/outline:\s*none/);
  });

  it("scrollbars are 8px with token colors", () => {
    expect(base).toMatch(/::-webkit-scrollbar\s*\{\s*width: 8px;\s*height: 8px;/);
    expect(base).toContain("var(--c-scrollbar-thumb)");
    expect(base).toContain("var(--c-scrollbar-thumb-hover)");
    expect(base).toContain("var(--c-scrollbar-thumb-active)");
  });

  it("native controls follow the mode", () => {
    expect(base).toMatch(/:root\.dark\s*\{\s*color-scheme: dark;/);
    expect(base).toMatch(/:root\.light\s*\{\s*color-scheme: light;/);
  });
});
