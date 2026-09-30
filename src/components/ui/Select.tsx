import type { ComponentPropsWithRef } from "react";
import { ChevronDownIcon } from "../../lib/icons";
import { cx } from "./cx";

export interface SelectProps extends ComponentPropsWithRef<"select"> {
  wrapperClassName?: string;
}

/** A native select; its popup follows color-scheme (base.css). */
export function Select({ className, wrapperClassName, children, ...rest }: SelectProps) {
  return (
    <span className={cx("relative block w-full", wrapperClassName)}>
      <select
        className={cx(
          "h-control w-full appearance-none rounded border border-(--c-dropdown-border) bg-(--c-dropdown-bg) pl-2 pr-7 text-body text-ink disabled:opacity-40",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon size={16} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted" />
    </span>
  );
}
