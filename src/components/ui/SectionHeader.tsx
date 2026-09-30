import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "./cx";

export interface SectionHeaderProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls on the title line. */
  actions?: ReactNode;
}

/** The title must stay an h3: the harness reads Sync tab section titles from h3 (B37). */
export function SectionHeader({ title, description, actions, className, ...rest }: SectionHeaderProps) {
  return (
    <div className={cx("mb-2", className)} {...rest}>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-label font-semibold text-ink-secondary">{title}</h3>
        {actions}
      </div>
      {description && <p className="mt-0.5 text-meta text-ink-muted">{description}</p>}
    </div>
  );
}
