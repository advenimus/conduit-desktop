import type { ComponentPropsWithRef } from "react";
import { LoaderIcon } from "../../lib/icons";
import { cx } from "./cx";

export interface SpinnerProps extends Omit<ComponentPropsWithRef<"span">, "children"> {
  size?: 12 | 16 | 24;
  /** Accessible name; the spinner is decorative without one. */
  label?: string;
  /** Visible text next to the icon. The harness reads busy texts such as "Loading..." (B35). */
  text?: string;
}

/** One <span> root, so ref, className and data-* hooks land on the same element with or without text. Never role="status": that role belongs to banners only (spec 8.4). */
export function Spinner({ size = 16, label, text, className, ...rest }: SpinnerProps) {
  return (
    <span className={cx("inline-flex items-center", text && "gap-2", className)} {...rest}>
      <LoaderIcon size={size} compact={size === 12} title={label} className="shrink-0 animate-spin motion-reduce:animate-none" />
      {text}
    </span>
  );
}
