import type { ComponentPropsWithRef } from "react";
import { cx } from "./cx";

/** Inner container: 6px radius, card border, well background (spec 4.13). */
export function Card({ className, ...rest }: ComponentPropsWithRef<"div">) {
  return <div className={cx("rounded-md border border-card-border bg-well p-3", className)} {...rest} />;
}
