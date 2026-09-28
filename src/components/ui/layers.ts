/**
 * The layer stack (spec 4.8). One capturing keydown listener serves every open dialog and popover:
 * Escape goes to the most recently opened layer only and never reaches the one underneath (Settings
 * would otherwise close and drop unsaved edits while a sync panel stayed open), and Tab cycles inside
 * the top layer when it traps focus. A layer without an Escape action still swallows the key.
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

function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.closest("[hidden], [inert]") === null,
  );
}

function trapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = tabbables(root);
  if (items.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const index = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  if (e.shiftKey && index <= 0) {
    e.preventDefault();
    items[last].focus();
  } else if (!e.shiftKey && (index === -1 || index === last)) {
    e.preventDefault();
    items[0].focus();
  }
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
  const root = top.ref?.current;
  if (e.key === "Tab" && top.trapFocus && root) trapTab(e, root);
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
