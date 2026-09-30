import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export interface EmptyStateProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
  icon?: IconSource;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...rest }: EmptyStateProps) {
  return (
    <div className={cx("flex flex-col items-center gap-2 py-8 text-center", className)} {...rest}>
      {icon && <IconSlot icon={icon} size={32} className="text-ink-faint" />}
      <p className="text-body text-ink-secondary">{title}</p>
      {description && <p className="text-label text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}
