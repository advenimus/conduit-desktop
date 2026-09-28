/**
 * The layer stack (spec 4.8). One capturing keydown listener serves every open dialog and popover:
 * Escape goes to the most recently opened layer only and never reaches the one underneath (Settings
 * would otherwise close and drop unsaved edits while a sync panel stayed open), and Tab cycles inside
 * the topmost layer that traps focus, together with every popover opened above it. A layer without an
 * Escape action still swallows the key.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

interface LayerEntry {
  readonly escape: { readonly current: (() => void) | undefined };
  readonly ref: RefObject<HTMLElement | null> | null;
  readonly trapFocus: boolean;
}

export interface LayerOptions {
  ref: RefObject<HTMLElement | null>;
  onEscape?: () => void;
  trapFocus?: boolean;
  /** False keeps the layer off the stack, for a surface that is still mounted while it closes. */
  active?: boolean;
}

const TABBABLE = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[tabindex]",
  "[contenteditable=true]",
].join(",");

let stack: readonly LayerEntry[] = [];

function isShown(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
  // jsdom has no checkVisibility and no layout; computed display and visibility are enough there.
  const visibility = window.getComputedStyle(el).visibility;
  if (visibility === "hidden" || visibility === "collapse") return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (window.getComputedStyle(node).display === "none") return false;
  }
  return true;
}

/** The browser stops once per radio group: on the checked radio, else on the first one. */
function oneStopPerRadioGroup(items: HTMLElement[]): HTMLElement[] {
  const groups: Array<{ form: HTMLFormElement | null; name: string; radios: HTMLInputElement[] }> = [];
  for (const el of items) {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) continue;
    const group = groups.find((g) => g.form === el.form && g.name === el.name);
    if (group) group.radios.push(el);
    else groups.push({ form: el.form, name: el.name, radios: [el] });
  }
  const stops = new Set(groups.map((g) => g.radios.find((r) => r.checked) ?? g.radios[0]));
  const skipped = new Set(groups.flatMap((g) => g.radios).filter((r) => !stops.has(r)));
  return items.filter((el) => !skipped.has(el as HTMLInputElement));
}

function byDocumentOrder(a: Node, b: Node): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function tabbables(roots: readonly HTMLElement[]): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const root of roots) {
    for (const el of root.querySelectorAll<HTMLElement>(TABBABLE)) {
      if (el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.closest("[hidden], [inert]") === null && isShown(el)) found.add(el);
    }
  }
  return oneStopPerRadioGroup([...found].sort(byDocumentOrder));
}

function follows(item: HTMLElement, active: Element): boolean {
  return (active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Wraps at both ends. Focus on an element outside the list (a menu item with tabindex -1, or outside
 * the layers) moves to the nearest stop in document order. With a popover above the modal layer the
 * roots are not next to each other in the document, so every move is made here, not by the browser.
 */
function trapTab(e: KeyboardEvent, roots: readonly HTMLElement[]): void {
  const items = tabbables(roots);
  if (items.length === 0) {
    e.preventDefault();
    roots[0].focus();
    return;
  }
  const active = document.activeElement ?? document.body;
  const index = items.indexOf(active as HTMLElement);
  const last = items.length - 1;
  const explicit = roots.length > 1;
  let target: HTMLElement | undefined;
  if (index === -1) {
    target = e.shiftKey ? [...items].reverse().find((item) => !follows(item, active)) ?? items[last] : items.find((item) => follows(item, active)) ?? items[0];
  } else if (e.shiftKey) {
    target = index === 0 ? items[last] : explicit ? items[index - 1] : undefined;
  } else {
    target = index === last ? items[0] : explicit ? items[index + 1] : undefined;
  }
  if (!target) return;
  e.preventDefault();
  target.focus();
}

/** The topmost trapping layer and every layer above it, as roots; empty when no layer traps. */
function trapRoots(): HTMLElement[] {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (!stack[i].trapFocus) continue;
    return stack.slice(i).flatMap((layer) => (layer.ref?.current ? [layer.ref.current] : []));
  }
  return [];
}

function onKeyDown(e: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (top === undefined) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    top.escape.current?.();
    return;
  }
  if (e.key !== "Tab") return;
  const roots = trapRoots();
  if (roots.length > 0) trapTab(e, roots);
}

function push(entry: LayerEntry): void {
  if (stack.length === 0) document.addEventListener("keydown", onKeyDown, true);
  stack = [...stack, entry];
}

function remove(entry: LayerEntry): void {
  stack = stack.filter((l) => l !== entry);
  if (stack.length === 0) document.removeEventListener("keydown", onKeyDown, true);
}

function useLayerEntry(ref: RefObject<HTMLElement | null> | null, onEscape: (() => void) | undefined, trapFocus: boolean, active: boolean): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useLayoutEffect(() => {
    if (!active) return;
    const entry: LayerEntry = { escape, ref, trapFocus };
    push(entry);
    return () => remove(entry);
  }, [ref, trapFocus, active]);
}

export function useLayer({ ref, onEscape, trapFocus = false, active = true }: LayerOptions): void {
  useLayerEntry(ref, onEscape, trapFocus, active);
}

/** Escape only, for shells that are not Dialog yet. Same contract as the sync dialogs had. */
export function useEscapeLayer(onEscape: (() => void) | undefined): void {
  useLayerEntry(null, onEscape, false, true);
}
