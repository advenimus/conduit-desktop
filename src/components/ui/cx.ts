/** Joins class names. It does not merge conflicting utilities: a className that must beat a primitive's own class of the same property needs the important suffix (spec 4.1). */
export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

/** Hover color changes over 100ms. Not transition-colors: in Tailwind v4 it also fades outline-color, so a new focus ring would fade in from the text color. */
export const COLOR_TRANSITION = "transition-[color,background-color,border-color] duration-100";
