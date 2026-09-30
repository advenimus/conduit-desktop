import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "./cx";

export interface TextInputProps extends ComponentPropsWithRef<"input"> {
  invalid?: boolean;
  /** A 16px icon 6px from the left edge. */
  leading?: ReactNode;
  /** A 16px icon or a small IconButton, centered 6px from the right edge. */
  trailing?: ReactNode;
}

export const FIELD_COLORS =
  "rounded border bg-input text-(--c-input-fg) placeholder:text-(--c-input-placeholder) disabled:opacity-40";

export function TextInput({ invalid = false, leading, trailing, className, type = "text", ...rest }: TextInputProps) {
  const input = (
    <input
      type={type}
      aria-invalid={invalid || undefined}
      className={cx(
        "h-control w-full text-body leading-4",
        FIELD_COLORS,
        invalid ? "border-danger" : "border-input-border",
        leading ? "pl-7" : "pl-1.5",
        trailing ? "pr-7" : "pr-1.5",
        className,
      )}
      {...rest}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <span className="relative block w-full">
      {leading && (
        <span className="pointer-events-none absolute left-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center text-ink-muted">
          {leading}
        </span>
      )}
      {input}
      {trailing && (
        <span className="absolute right-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center">{trailing}</span>
      )}
    </span>
  );
}
