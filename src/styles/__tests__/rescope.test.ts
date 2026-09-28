import { describe, expect, it } from "vitest";
import { readRepoFile } from "./cssTokens";

// The selected-row re-scope (spec 2.11) as base.css declares it: the first rule that redeclares --c-ink-muted.
function rescopeSelector(): string {
  const css = readRepoFile("src", "styles", "base.css");
  const match = /([^{}]+)\{[^}]*--c-ink-muted:\s*var\(--c-ink-secondary\)/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  if (!match) throw new Error("no re-scope rule in base.css");
  return match[1].trim();
}

function element(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as Element;
}

describe("selected-row re-scope (spec 2.11)", () => {
  const selector = rescopeSelector();

  it.each([
    ['<div role="option" aria-selected="true"></div>'],
    ['<div role="treeitem" aria-selected="true"></div>'],
    ['<div role="row" aria-selected="true"></div>'],
    ['<div role="gridcell" aria-selected="true"></div>'],
    ["<button data-selected></button>"],
    ['<button role="radio" aria-checked="true" data-selected></button>'],
  ])("re-scopes a selected row: %s", (html) => {
    expect(element(html).matches(selector)).toBe(true);
  });

  it.each([
    ['<div class="cv-tab" role="tab" aria-selected="true"></div>'],
    ['<button role="tab" aria-selected="true"></button>'],
    ['<div role="option" aria-selected="false"></div>'],
    ['<div aria-selected="true"></div>'],
  ])("leaves anything else alone, a selected tab included: %s", (html) => {
    expect(element(html).matches(selector)).toBe(false);
  });
});
