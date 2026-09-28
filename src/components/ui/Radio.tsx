import { createContext, useContext, useId, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "./cx";

interface RadioGroupContextValue {
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps<T extends string> extends Omit<ComponentPropsWithRef<"div">, "onChange"> {
  value: T;
  onChange: (value: T) => void;
  name?: string;
  disabled?: boolean;
  children: ReactNode;
}

/** Radios share one name, so the browser's own arrow keys move between them. */
export function RadioGroup<T extends string>({ value, onChange, name, disabled = false, className, children, ...rest }: RadioGroupProps<T>) {
  const generated = useId();
  const context: RadioGroupContextValue = {
    name: name ?? generated,
    value,
    onChange: (next) => onChange(next as T),
    disabled,
  };
  return (
    <div role="radiogroup" className={cx("flex flex-col gap-2", className)} {...rest}>
      <RadioGroupContext.Provider value={context}>{children}</RadioGroupContext.Provider>
    </div>
  );
}

export interface RadioProps extends Omit<ComponentPropsWithRef<"input">, "type" | "onChange" | "value" | "children"> {
  value: string;
  /** Exactly the option text: the harness matches the label's whole text (B46). */
  children: ReactNode;
  /** Standalone use without a RadioGroup. */
  onChange?: (value: string) => void;
}

export function Radio({ value, children, checked, onChange, name, disabled, className, ...rest }: RadioProps) {
  const group = useContext(RadioGroupContext);
  const isChecked = group ? group.value === value : checked === true;
  const isDisabled = disabled ?? group?.disabled ?? false;
  return (
    <label className={cx("inline-flex items-center gap-2 text-body text-ink-secondary", isDisabled && "opacity-40", className)}>
      <span className="relative inline-flex shrink-0">
        <input
          type="radio"
          name={group?.name ?? name}
          value={value}
          checked={isChecked}
          disabled={isDisabled}
          onChange={() => (group ? group.onChange(value) : onChange?.(value))}
          className="peer size-4 shrink-0 appearance-none rounded-full border border-(--c-checkbox-border) bg-(--c-checkbox-bg) checked:border-btn-primary"
          {...rest}
        />
        <span aria-hidden="true" className="pointer-events-none absolute left-1 top-1 hidden size-2 rounded-full bg-btn-primary peer-checked:block" />
      </span>
      {children}
    </label>
  );
}
