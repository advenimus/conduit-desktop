// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import type { Root, Rule } from "postcss";
import { compileIndexCss, readRepoFile } from "./cssTokens";

let root: Root;

beforeAll(async () => {
  root = await compileIndexCss();
}, 60_000);

/** Every declaration of the compiled rules whose selector list contains `selector` exactly. */
function declsOf(selector: string): Record<string, string> {
  const decls: Record<string, string> = {};
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
  });
  return decls;
}

describe("pane tab bars (spec 3.4)", () => {
  const tabs = readRepoFile("src", "styles", "components", "tabs.css");

  it("the strip is 33px on the strip color and never shows a scrollbar", () => {
    expect(declsOf(".cv-tabstrip")).toMatchObject({ height: "var(--c-tabstrip-h)", overflow: "hidden", background: "var(--c-tabstrip)" });
    expect(declsOf(".cv-tabs")).toMatchObject({ "overflow-x": "auto", "scrollbar-width": "none", "padding-top": "var(--c-tab-gutter-top)" });
  });

  it("tabs shrink to fit down to the 78px floor, the label giving way first", () => {
    expect(declsOf(".cv-tab")).toMatchObject({ flex: "0 1 auto", "min-width": "var(--c-tab-min-w)", height: "var(--c-tab-h)", padding: "0 4px 0 8px", gap: "6px" });
    expect(declsOf(".cv-tab > *")).toMatchObject({ flex: "none" });
    expect(declsOf(".cv-tab > .cv-tab-label")).toMatchObject({ flex: "0 1 auto", "min-width": "0", "max-width": "120px" });
  });

  it("the active tab is marked with data-active and its fill reaches the strip bottom", () => {
    expect(tabs).not.toContain("aria-selected");
    expect(declsOf(".cv-tab[data-active] > .cv-tab-fill")).toMatchObject({
      bottom: "calc(var(--c-tab-gutter-top) + var(--c-tab-h) - var(--c-tabstrip-h))",
      background: "var(--c-tab-active-bg)",
    });
  });

  it("close buttons stay visible on every tab (D-3): colored, never hidden", () => {
    expect(declsOf(".cv-tab .cv-tab-close")).toEqual({ color: "var(--c-tab-fg)" });
    expect(declsOf(".cv-tab[data-active] .cv-tab-close")).toEqual({ color: "var(--c-tab-fg-active)" });
    expect(declsOf(".cv-tab:hover .cv-tab-close")).toEqual({ color: "var(--c-tab-fg-active)" });
    expect(tabs).not.toMatch(/opacity:\s*0\b|visibility:\s*hidden|display:\s*none/);
  });

  it("drops the card and editor action rules", () => {
    expect(tabs).not.toMatch(/cv-editor-actions|cv-tab-actions|data-state/);
  });
});

describe("resize handles (spec 3.5 to 3.7)", () => {
  const sash = readRepoFile("src", "styles", "components", "sash.css");

  it("keeps the pane splits and the AI divider 4px, with no grip and no density rules", () => {
    expect(declsOf(".cv-sash")).toMatchObject({ width: "4px" });
    expect(sash).not.toMatch(/data-density|sash-grip|box-shadow/);
  });

  it("paints the AI divider as a 1px line between the panes and the panel", () => {
    expect(declsOf(".cv-sash-ai").background).toBe(
      "linear-gradient(to right, var(--c-editor) 0 1.5px, var(--c-divider) 1.5px 2.5px, var(--c-sidebar) 2.5px)",
    );
  });

  it("lights up in the accent after the hover delay, at once while dragging", () => {
    expect(declsOf(".cv-split-sash:hover::after")).toEqual({ opacity: "1", "transition-delay": "var(--c-sash-delay)" });
    expect(declsOf(".cv-split-sash[data-dragging]::after")).toEqual({ opacity: "1", "transition-delay": "0s" });
    expect(declsOf(".cv-sash-handle:hover > .cv-sash-line")).toEqual({ opacity: "1", "transition-delay": "var(--c-sash-delay)" });
    expect(declsOf(".cv-sash-line")).toMatchObject({ width: "4px" });
  });
});
