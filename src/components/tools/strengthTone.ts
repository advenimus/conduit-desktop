export interface StrengthTone {
  bar: string;
  text: string;
}

const WEAKEST: StrengthTone = { bar: "bg-danger", text: "text-danger" };

// Five strength steps on three status tokens: the in-between steps mix their neighbors.
const TONES: Readonly<Record<string, StrengthTone>> = {
  "red-500": WEAKEST,
  "orange-500": {
    bar: "bg-[color-mix(in_srgb,var(--c-danger),var(--c-warning))]",
    text: "text-[color-mix(in_srgb,var(--c-danger),var(--c-warning))]",
  },
  "yellow-500": { bar: "bg-warning", text: "text-warning" },
  "green-500": {
    bar: "bg-[color-mix(in_srgb,var(--c-warning)_30%,var(--c-success))]",
    text: "text-[color-mix(in_srgb,var(--c-warning)_30%,var(--c-success))]",
  },
  "emerald-500": { bar: "bg-success", text: "text-success" },
};

/** Token classes for a `scorePassword` color name. */
export function strengthTone(color: string): StrengthTone {
  return TONES[color] ?? WEAKEST;
}
