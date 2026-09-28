import { useRef, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";
import { useMergedRef } from "./refs";
import { enabledItems, rovingIndex } from "./roving";

export interface SegmentOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: IconSource;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> extends Omit<ComponentPropsWithRef<"div">, "onChange"> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
}

/** One neutral style for every segmented choice (D-13): a radiogroup where arrows move and select. */
export function SegmentedControl<T extends string>({ options, value, onChange, className, ref, ...rest }: SegmentedControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const setRef = useMergedRef(groupRef, ref);
  const hasChecked = options.some((o) => o.value === value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const radios = enabledItems(groupRef.current, "[role=radio]");
    const next = rovingIndex(e.key, radios.indexOf(document.activeElement as HTMLElement), radios.length, "both");
    if (next === null) return;
    e.preventDefault();
    const target = radios[next];
    target.focus();
    const option = options.find((o) => o.value === target.dataset.value);
    if (option) onChange(option.value);
  };

  return (
    <div
      ref={setRef}
      role="radiogroup"
      onKeyDown={onKeyDown}
      className={cx("inline-flex gap-0.5 rounded-md bg-well p-0.5", className)}
      {...rest}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!hasChecked && index === 0) ? 0 : -1}
            disabled={option.disabled}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            className={cx(
              "inline-flex h-control-sm items-center gap-1 rounded px-2 text-label disabled:opacity-40",
              checked ? "bg-selected text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            {option.icon && <IconSlot icon={option.icon} className="shrink-0" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
