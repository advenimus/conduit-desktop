import type { ComponentPropsWithRef } from "react";
import { COLOR_TRANSITION, cx } from "./cx";

export interface SwitchProps extends Omit<ComponentPropsWithRef<"button">, "onChange" | "children"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name when no <label htmlFor> points at the switch. */
  label?: string;
}

/**
 * A single <button role="switch">, so a toggle row can hold it as a direct child (B39). The off track
 * uses the checkbox tokens: its border is the 3:1 boundary (spec 4.6, 2.11).
 */
export function Switch({ checked, onChange, label, disabled, className, type = "button", ...rest }: SwitchProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border disabled:opacity-40",
        COLOR_TRANSITION,
        checked ? "border-transparent bg-btn-primary" : "border-(--c-checkbox-border) bg-(--c-checkbox-bg)",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          "ml-px size-3 rounded-full transition-transform duration-100",
          checked ? "translate-x-3 bg-white" : "translate-x-0 bg-ink-muted",
        )}
      />
    </button>
  );
}
