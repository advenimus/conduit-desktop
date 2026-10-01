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

  it("the strip is 38px on the strip color, ruled off below, and never shows a scrollbar", () => {
    expect(declsOf(".cv-tabstrip")).toMatchObject({
      height: "var(--c-tabstrip-h)",
      overflow: "hidden",
      background: "var(--c-tabstrip)",
      "box-shadow": "inset 0 -1px 0 var(--c-divider)",
    });
    expect(declsOf(".cv-tabs")).toMatchObject({ "align-items": "center", "overflow-x": "auto", "scrollbar-width": "none" });
  });

  it("tabs shrink to fit down to the 78px floor, the label giving way first", () => {
    expect(declsOf(".cv-tab")).toMatchObject({ flex: "0 1 auto", "min-width": "var(--c-tab-min-w)", height: "var(--c-tab-h)", padding: "0 4px 0 10px", gap: "6px" });
    expect(declsOf(".cv-tab > *")).toMatchObject({ flex: "none" });
    expect(declsOf(".cv-tab > .cv-tab-label")).toMatchObject({ flex: "0 1 auto", "min-width": "0", "max-width": "140px" });
  });

  it("the active tab is an accent-tinted pill, like the iPad app's tab strip", () => {
    expect(tabs).not.toContain("aria-selected");
    expect(declsOf(".cv-tab-fill")).toMatchObject({ "border-radius": "var(--c-radius-md)" });
    expect(declsOf(".cv-tab[data-active]")).toMatchObject({ color: "var(--c-accent-text)" });
    expect(declsOf(".cv-tab[data-active] > .cv-tab-fill")).toMatchObject({
      background: "color-mix(in srgb, var(--c-accent) 16%, transparent)",
      "border-color": "color-mix(in srgb, var(--c-accent) 35%, transparent)",
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

describe("unified title bar (macOS)", () => {
  const css = readRepoFile("src", "styles", "components", "titlebar.css");

  it("the bars move the window and their controls stay clickable", () => {
    expect(css).toMatch(/\[data-titlebar="inset"\] :is\(\[data-cv-titlebar\], \[data-cv-top-banners\] > \*\) \{ -webkit-app-region: drag; app-region: drag; \}/);
    expect(css).toMatch(/:is\(button, a, input, select, textarea, \[role="button"\], \[role="menu"\], \[draggable="true"\], \.cv-tab\) \{ -webkit-app-region: no-drag;/);
  });

  it("drag regions step aside under dialogs, the floating side bar and tab drags", () => {
    expect(css).toContain(':has([data-dialog-content])');
    expect(css).toMatch(/:is\(:has\(\[data-dialog-content\]\), \[data-cv-tab-dragging\]\)\s+:is\(\[data-cv-titlebar\], \[data-cv-top-banners\] > \*\) \{/);
    expect(css).toContain(':has([data-sidebar-panel]:not([data-docked]))');
  });

  it("a floating side bar's header still moves the window: the side bar comes after the bars in the page", () => {
    expect(css).toMatch(/:has\(\[data-sidebar-panel\]:not\(\[data-docked\]\)\)\s+:is\(\[data-cv-titlebar\]:not\(\[data-cv-sidebar-header\]\), \[data-cv-top-banners\] > \*\) \{\s+-webkit-app-region: no-drag;/);
    const app = readRepoFile("src", "App.tsx");
    expect(app.indexOf("<Sidebar />")).toBeGreaterThan(app.indexOf("<ChatPanel />"));
    expect(readRepoFile("src", "components", "layout", "SidebarPanel.tsx")).toContain("relative z-30 order-first flex-shrink-0");
  });

  it("every bar along the top keeps a gap at its end for moving the window", () => {
    expect(css).toContain('[data-titlebar="inset"] .cv-tabstrip[data-cv-titlebar] .cv-tabs { padding-right: 28px; }');
  });

  it("keeps room for the window buttons, none in full screen, and none below a banner row", () => {
    expect(css).toContain(':root[data-titlebar="inset"] { --cv-window-controls-w: 86px;');
    expect(css).toContain(':root[data-titlebar="inset"][data-fullscreen] { --cv-window-controls-w: 0px; }');
    expect(css).toContain(':root[data-titlebar="inset"]:has([data-cv-top-banners] > *) { --cv-window-lead: 0px; }');
  });

  it("matches the 38px bar the window buttons are centered in", () => {
    expect(readRepoFile("electron", "window-title-bar.ts")).toContain("{ x: 14, y: 12 }");
    expect(readRepoFile("src", "styles", "tokens.css")).toContain("--c-tabstrip-h: 38px;");
  });
});
