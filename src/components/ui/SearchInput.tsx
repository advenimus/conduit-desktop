import { useRef, type ComponentPropsWithRef } from "react";
import { SearchIcon } from "../../lib/icons";
import { cx } from "./cx";
import { IconButton } from "./IconButton";
import { useMergedRef } from "./refs";

export interface SearchInputProps extends Omit<ComponentPropsWithRef<"input">, "value" | "onChange" | "type"> {
  value: string;
  onChange: (value: string) => void;
  /** Called after the clear button empties the field. */
  onClear?: () => void;
  wrapperClassName?: string;
}

/** The wrapper shows focus; the inner input is data-bare (spec 2.7, 4.4). */
export function SearchInput({ value, onChange, onClear, wrapperClassName, className, ref, ...rest }: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setRef = useMergedRef(inputRef, ref);
  return (
    <span
      className={cx(
        "flex h-control w-full items-center gap-1.5 rounded border border-input-border bg-input px-1.5",
        "focus-within:outline focus-within:outline-1 focus-within:outline-(--c-focus) focus-within:-outline-offset-1",
        wrapperClassName,
      )}
    >
      <SearchIcon size={16} className="shrink-0 text-ink-muted" />
      <input
        ref={setRef}
        type="text"
        data-bare=""
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "h-full min-w-0 flex-1 bg-transparent text-body text-(--c-input-fg) outline-hidden placeholder:text-(--c-input-placeholder)",
          className,
        )}
        {...rest}
      />
      {value !== "" && (
        <IconButton
          size="sm"
          icon="close"
          label="Clear search"
          onClick={() => {
            onChange("");
            onClear?.();
            inputRef.current?.focus();
          }}
        />
      )}
    </span>
  );
}
