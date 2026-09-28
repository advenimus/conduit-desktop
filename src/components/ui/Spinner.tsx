import { LoaderIcon } from "../../lib/icons";
import { cx } from "./cx";

export interface SpinnerProps {
  size?: 12 | 16 | 24;
  /** Accessible name; the spinner is decorative without one. */
  label?: string;
  /** Visible text next to the icon. The harness reads busy texts such as "Loading..." (B35). */
  text?: string;
  className?: string;
}

/** Never role="status": that role belongs to banners only (spec 8.4). */
export function Spinner({ size = 16, label, text, className }: SpinnerProps) {
  const icon = (
    <LoaderIcon size={size} compact={size === 12} title={label} className={cx("shrink-0 animate-spin motion-reduce:animate-none", !text && className)} />
  );
  if (!text) return icon;
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      {icon}
      {text}
    </span>
  );
}
