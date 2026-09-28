import { useEffect, useRef } from "react";

/**
 * Escape for stacked sync dialogs. Only the most recently opened one reacts, wherever focus is,
 * and the key never reaches the dialog underneath (Settings would otherwise close and drop
 * unsaved edits while the sync panel stayed open). A dialog without an Escape action swallows it.
 */
type Layer = { readonly current: (() => void) | undefined };

let layers: readonly Layer[] = [];

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const top = layers[layers.length - 1];
  if (top === undefined) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  top.current?.();
}

export function useEscapeLayer(onEscape: (() => void) | undefined): void {
  const handler = useRef(onEscape);
  useEffect(() => {
    handler.current = onEscape;
  });
  useEffect(() => {
    const layer: Layer = handler;
    if (layers.length === 0) document.addEventListener("keydown", onKeyDown, true);
    layers = [...layers, layer];
    return () => {
      layers = layers.filter((l) => l !== layer);
      if (layers.length === 0) document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
}
