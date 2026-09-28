import { cloneElement, isValidElement, useId, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";
import { cx } from "./cx";

export interface SettingsRowProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /**
   * A Switch shown beside the title. The row then keeps the harness-bound markup (B22, B39): the title is
   * a <label> with its exact text and the switch a direct child of the .justify-between toggle row.
   */
  toggle?: ReactElement<{ id?: string }>;
  children?: ReactNode;
}

export function SettingsRow({ title, description, toggle, className, children, ...rest }: SettingsRowProps) {
  const generatedId = useId();
  const toggleId = (isValidElement(toggle) && toggle.props.id) || generatedId;
  return (
    <div className={cx("grid gap-1 border-b border-divider py-3 last:border-0", className)} {...rest}>
      {toggle ? (
        <div data-cv-toggle-row="" className="flex items-center justify-between gap-4">
          <label htmlFor={toggleId} className="text-body font-semibold text-ink">
            {title}
          </label>
          {cloneElement(toggle, { id: toggleId })}
        </div>
      ) : (
        <div className="text-body font-semibold text-ink">{title}</div>
      )}
      {description && <div className="text-label text-ink-muted">{description}</div>}
      {children && <div className="max-w-[420px]">{children}</div>}
    </div>
  );
}
