import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export interface KbdProps extends ComponentPropsWithRef<"kbd"> {
  /** Inside a filled button: a white border and text. */
  onFilled?: boolean;
}

export function Kbd({ onFilled = false, className, ...rest }: KbdProps) {
  return (
    <kbd
      className={cx(
        "inline-flex h-4 min-w-4 items-center justify-center rounded border px-1.5 font-mono text-meta",
        onFilled ? "border-white/40 text-white" : "border-control text-ink-muted",
        className,
      )}
      {...rest}
    />
  );
}
