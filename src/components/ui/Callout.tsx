import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export type CalloutTone = "info" | "warning" | "danger" | "success";

export interface CalloutProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
  tone?: CalloutTone;
  title?: ReactNode;
  icon?: IconSource;
  /** A row of Button size="sm". */
  actions?: ReactNode;
  size?: "sm" | "md";
}

const TONE: Readonly<Record<CalloutTone, { box: string; icon: string; glyph: IconSource }>> = {
  info: { box: "bg-info-bg border-info-border", icon: "text-info", glyph: "infoCircle" },
  warning: { box: "bg-warning-bg border-warning-border", icon: "text-warning", glyph: "alertTriangle" },
  danger: { box: "bg-danger-bg border-danger-border", icon: "text-danger", glyph: "alertCircle" },
  success: { box: "bg-success-bg border-success-border", icon: "text-success", glyph: "circleCheck" },
};

/** Inline notice (spec 4.13). A danger callout's text is <p data-cv-error>, which the harness reads (B8). */
export function Callout({ tone = "info", title, icon, actions, size = "md", className, children, ...rest }: CalloutProps) {
  const style = TONE[tone];
  return (
    <div className={cx("flex gap-2 rounded-md border text-label", size === "sm" ? "p-2" : "p-2.5", style.box, className)} {...rest}>
      <IconSlot icon={icon ?? style.glyph} className={cx("mt-px shrink-0", style.icon)} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children != null &&
          (tone === "danger" ? (
            <p data-cv-error="" className="text-ink-secondary">
              {children}
            </p>
          ) : (
            <div className="text-ink-secondary">{children}</div>
          ))}
        {actions && <div className="mt-2 flex gap-2">{actions}</div>}
      </div>
    </div>
  );
}
