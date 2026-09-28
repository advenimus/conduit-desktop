import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "./cx";

export interface SliderProps extends Omit<ComponentPropsWithRef<"input">, "type"> {
  /** Min, middle and max labels under the track. */
  marks?: readonly [ReactNode, ReactNode, ReactNode];
  wrapperClassName?: string;
}

export function Slider({ marks, className, wrapperClassName, ...rest }: SliderProps) {
  return (
    <span className={cx("block w-full", wrapperClassName)}>
      <input type="range" className={cx("h-4 w-full accent-(--c-accent)", className)} {...rest} />
      {marks && (
        <span className="mt-1 flex justify-between text-meta text-ink-muted">
          <span>{marks[0]}</span>
          <span>{marks[1]}</span>
          <span>{marks[2]}</span>
        </span>
      )}
    </span>
  );
}
