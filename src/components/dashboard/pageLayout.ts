import { cx } from "../ui";

/** Page content width for full-pane views. The header's divider still spans the pane. */
export const CONTENT_WIDTH = "mx-auto w-full max-w-[96rem]";

// Whole class names, so Tailwind's scanner sees them.
const WIDE_COLUMNS = {
  balanced: "@5xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]",
  sidebar: "@5xl:grid-cols-[minmax(0,1fr)_minmax(18rem,26rem)]",
} as const;

export type WideColumns = keyof typeof WIDE_COLUMNS;

/** Main content then a side panel, stacked on narrow panes and side by side on wide ones (the root needs @container). Null gives one full-width column. */
export const splitGrid = (columns: WideColumns | null) => cx("grid grid-cols-1 gap-x-6", columns && WIDE_COLUMNS[columns]);
