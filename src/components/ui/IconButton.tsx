import type { ComponentPropsWithRef } from "react";
import { COLOR_TRANSITION, cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  icon: IconSource;
  /** Required: becomes aria-label and the native tooltip. Callers append a shortcut hint in parentheses. */
  label: string;
  size?: IconButtonSize;
  /** Sets aria-pressed; with pressedLook (default) also the pressed background. */
  pressed?: boolean;
  /** False keeps aria-pressed but not the look, for controls that show state by swapping the glyph. */
  pressedLook?: boolean;
  tone?: "default" | "danger";
  /** Tooltip while disabled, saying why. */
  disabledReason?: string;
}

const BOX: Readonly<Record<IconButtonSize, string>> = {
  sm: "size-5",
  md: "size-toolbar",
  lg: "size-7",
};

const ICON_SIZE: Readonly<Record<IconButtonSize, number>> = { sm: 16, md: 16, lg: 20 };

export function IconButton({
  icon,
  label,
  size = "md",
  pressed,
  pressedLook = true,
  tone = "default",
  disabledReason,
  disabled,
  type = "button",
  className,
  ...rest
}: IconButtonProps) {
  const showPressed = pressed === true && pressedLook;
  return (
    <button
      type={type}
      aria-label={label}
      title={disabled && disabledReason ? disabledReason : label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      disabled={disabled}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded disabled:opacity-40",
        COLOR_TRANSITION,
        BOX[size],
        showPressed ? "bg-toolbar-active text-ink" : "text-ink-muted enabled:hover:bg-toolbar-hover enabled:active:bg-toolbar-active",
        tone === "danger" ? "enabled:hover:text-danger" : !showPressed && "enabled:hover:text-ink",
        className,
      )}
      {...rest}
    >
      <IconSlot icon={icon} size={ICON_SIZE[size]} />
    </button>
  );
}
