/** Arrow-key movement shared by Tabs, SegmentedControl, ChoiceGroup, NavList and Menu. */
export type RovingAxis = "horizontal" | "vertical" | "both";

const PREV: Readonly<Record<RovingAxis, ReadonlyArray<string>>> = {
  horizontal: ["ArrowLeft"],
  vertical: ["ArrowUp"],
  both: ["ArrowLeft", "ArrowUp"],
};

const NEXT: Readonly<Record<RovingAxis, ReadonlyArray<string>>> = {
  horizontal: ["ArrowRight"],
  vertical: ["ArrowDown"],
  both: ["ArrowRight", "ArrowDown"],
};

/** The index a key moves to, wrapping at both ends, or null when the key does not move. */
export function rovingIndex(key: string, current: number, count: number, axis: RovingAxis): number | null {
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (PREV[axis].includes(key)) return current <= 0 ? count - 1 : current - 1;
  if (NEXT[axis].includes(key)) return current < 0 || current >= count - 1 ? 0 : current + 1;
  return null;
}

/** Enabled elements matching `selector` inside `root`, in document order. */
export function enabledItems(root: HTMLElement | null, selector: string): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
}
