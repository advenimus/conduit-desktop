import type { ComponentPropsWithRef } from "react";
import { LoaderIcon } from "../../lib/icons";
import { COLOR_TRANSITION, cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconSource;
  iconEnd?: IconSource;
  /** Disables the button and swaps the icon for a spinner; the label stays visible text (B35). */
  loading?: boolean;
  /** Visible label while loading, for example "Opening..."; the children otherwise. */
  loadingLabel?: string;
  fullWidth?: boolean;
}

const BASE =
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded select-none disabled:opacity-40 disabled:pointer-events-none";

const SIZE_BOX: Readonly<Record<ButtonSize, string>> = {
  sm: "h-control-sm px-1.5",
  md: "h-control px-2",
  lg: "h-control-lg px-3",
};

const SIZE_TEXT: Readonly<Record<ButtonSize, string>> = {
  sm: "text-meta",
  md: "text-label",
  lg: "text-body",
};

const VARIANT: Readonly<Record<ButtonVariant, string>> = {
  primary: "border bg-btn-primary hover:bg-btn-primary-hover text-white border-transparent",
  secondary:
    "border bg-(--c-btn-secondary-bg) text-(--c-btn-secondary-fg) border-(--c-btn-secondary-border) hover:bg-(--c-btn-secondary-hover)",
  ghost: "border bg-transparent border-transparent text-ink-secondary hover:bg-hover hover:text-ink",
  danger: "border bg-btn-danger hover:bg-btn-danger-hover text-white border-transparent",
  link: "h-auto px-0 border-0 bg-transparent text-link hover:text-link-hover hover:underline",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  loading = false,
  loadingLabel,
  fullWidth = false,
  type = "button",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const iconSize = size === "sm" ? 12 : 16;
  const compact = size === "sm";
  const leading = loading ? (
    <LoaderIcon size={iconSize} compact={compact} className="shrink-0 animate-spin" />
  ) : icon ? (
    <IconSlot icon={icon} size={iconSize} compact={compact} className="shrink-0" />
  ) : null;

  return (
    <button
      type={type}
      data-cv-text-button=""
      disabled={disabled || loading}
      aria-busy={loading ? "true" : undefined}
      className={cx(
        BASE,
        COLOR_TRANSITION,
        variant === "link" ? SIZE_TEXT[size] : `${SIZE_BOX[size]} ${SIZE_TEXT[size]}`,
        VARIANT[variant],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {leading}
      {loading && loadingLabel ? loadingLabel : children}
      {iconEnd && !loading && <IconSlot icon={iconEnd} size={iconSize} compact={compact} className="shrink-0" />}
    </button>
  );
}
