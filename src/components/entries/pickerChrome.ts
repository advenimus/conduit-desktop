import { cx } from "../ui";

/** The overlay look of the in-app pickers (spec 3.16): position and size stay with each picker. */
export const PICKER_PANEL = "fixed z-(--c-z-popover) rounded-lg border border-overlay-border bg-overlay text-ink shadow-overlay";

export const PICKER_TITLE = "text-label font-semibold text-ink-muted";

/** The "Use Default" row: selected when no custom value is set. */
export function defaultRowClass(selected: boolean): string {
  return cx(
    "w-full rounded px-2 py-1.5 text-left text-label",
    selected ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover",
  );
}
