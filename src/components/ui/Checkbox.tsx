import type { ComponentPropsWithRef, ReactNode } from "react";
import { CheckIcon } from "../../lib/icons";
import { cx } from "./cx";

export interface CheckboxProps extends Omit<ComponentPropsWithRef<"input">, "type" | "onChange" | "checked" | "children"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The label text. The harness finds the checkbox by the label that contains it (ui-forms.mjs setCheckbox). */
  children: ReactNode;
  description?: ReactNode;
}

/** <label> wrapping input[type=checkbox] and the text; the input draws the 18px box (spec 4.6). */
export function Checkbox({ checked, onChange, children, description, disabled, className, ...rest }: CheckboxProps) {
  return (
    <label className={cx("inline-flex items-start gap-2 text-body text-ink-secondary", disabled && "opacity-40", className)}>
      <span className="relative inline-flex shrink-0">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer size-[18px] shrink-0 appearance-none rounded-[3px] border border-(--c-checkbox-border) bg-(--c-checkbox-bg) checked:border-btn-primary checked:bg-btn-primary"
          {...rest}
        />
        <CheckIcon size={16} className="pointer-events-none absolute left-px top-px hidden text-white peer-checked:block" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {description && <span className="text-meta text-ink-muted">{description}</span>}
      </span>
    </label>
  );
}
