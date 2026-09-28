import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";
import { FIELD_COLORS } from "./TextInput";

export interface TextareaProps extends ComponentPropsWithRef<"textarea"> {
  invalid?: boolean;
}

export function Textarea({ invalid = false, className, ...rest }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cx(
        "block w-full min-h-[78px] resize-y px-1.5 py-1 text-body leading-[18px]",
        FIELD_COLORS,
        invalid ? "border-danger" : "border-input-border",
        className,
      )}
      {...rest}
    />
  );
}
