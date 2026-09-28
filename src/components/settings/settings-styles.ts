// Shared looks of the Settings tabs (spec 3.12, 6.4). Section labels keep their element (<label> or
// <h3>) because the restyle inventory compares tags; only the look changes.

/** A section label: `<label>` or `<h3>` with the section label look. */
export const SECTION_LABEL = "block text-label font-semibold text-ink-secondary";

/** A hint or description under a control. */
export const HINT = "text-meta text-ink-muted";

/** A value beside a label, such as a slider's percentage. */
export const CAPTION = "text-meta text-ink-muted tabular-nums";
