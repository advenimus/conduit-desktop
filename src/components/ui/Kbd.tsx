import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

export function Kbd({ className, ...rest }: ComponentPropsWithRef<"kbd">) {
  return <kbd className={cx("inline-flex h-4 items-center rounded border border-control px-1 font-mono text-meta text-ink-muted", className)} {...rest} />;
}
