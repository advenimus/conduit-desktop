import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export type BadgeTone = "neutral" | "accent" | "warning" | "danger" | "success";

export interface BadgeProps extends ComponentPropsWithRef<"span"> {
  tone?: BadgeTone;
  icon?: IconSource;
}

// Each tone's text passes 4.5:1 on its own tint (spec 2.11 rule 3).
const TONE: Readonly<Record<BadgeTone, string>> = {
  neutral: "bg-selected text-ink-secondary",
  accent: "bg-badge text-white",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  success: "bg-success-bg text-success",
};

export function Badge({ tone = "neutral", icon, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx("inline-flex h-4 items-center gap-0.5 rounded px-1 text-badge font-semibold", TONE[tone], className)} {...rest}>
      {icon && <IconSlot icon={icon} size={12} compact className="shrink-0" />}
      {children}
    </span>
  );
}

export interface CountBadgeProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
  count: number;
  /** Larger counts show as "{max}+". */
  max?: number;
}

/** A count bubble: 18px minimum, 3px 5px padding, 11px line, weight 400, 10px text (spec 4.12). */
export function CountBadge({ count, max, className, ...rest }: CountBadgeProps) {
  const text = max !== undefined && count > max ? `${max}+` : String(count);
  return (
    <span
      className={cx(
        "inline-block min-h-[18px] min-w-[18px] rounded-full bg-badge px-[5px] py-[3px] text-center text-badge font-normal leading-[11px] text-white",
        className,
      )}
      {...rest}
    >
      {text}
    </span>
  );
}
