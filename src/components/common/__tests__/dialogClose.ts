import { fireEvent } from "@testing-library/react";

/** Close-behavior probes for the dialog tests of spec 3.12.1: Escape, a scrim click and the close button. */

export function topPanel(): HTMLElement {
  const panels = document.querySelectorAll<HTMLElement>("[data-dialog-content]");
  const panel = panels[panels.length - 1];
  if (!panel) throw new Error("no dialog panel");
  return panel;
}

export function pressEscape(): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

export function clickScrim(): void {
  const scrim = topPanel().parentElement as HTMLElement;
  fireEvent.mouseDown(scrim);
  fireEvent.click(scrim);
}

/** The header's close button (IconButton "Close"), or null when the dialog hides it. */
export function closeButton(): HTMLButtonElement | null {
  return topPanel().querySelector<HTMLButtonElement>('button[aria-label="Close"]');
}
