export type IconA11yAttributes =
  | { readonly "aria-hidden": "true"; readonly focusable: "false" }
  | { readonly role: "img"; readonly "aria-label": string };

const DECORATIVE: IconA11yAttributes = Object.freeze({ "aria-hidden": "true", focusable: "false" });

/** Icons are decorative unless they carry a title, which becomes their accessible name. */
export function iconA11yAttributes(title?: string): IconA11yAttributes {
  return title ? { role: "img", "aria-label": title } : DECORATIVE;
}
