import { createContext, useContext, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { useMergedRef } from "./refs";
import { enabledItems, rovingIndex } from "./roving";

interface ChoiceGroupContextValue {
  value: string;
  /** False until a card matches the value; then every card stays reachable with Tab. */
  anyChecked: boolean;
  onChange: (value: string) => void;
}

const ChoiceGroupContext = createContext<ChoiceGroupContextValue | null>(null);

export interface ChoiceGroupProps<T extends string> extends Omit<ComponentPropsWithRef<"div">, "onChange"> {
  value: T;
  onChange: (value: T) => void;
  columns?: 2 | 3 | 4;
}

const COLUMNS = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" } as const;

/** A grid of ChoiceCards with radio semantics: arrows move and select (spec 4.13). The 3px padding holds the cards' outside focus ring. */
export function ChoiceGroup<T extends string>({ value, onChange, columns = 3, className, children, ref, ...rest }: ChoiceGroupProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);
  const setRef = useMergedRef(groupRef, ref);
  const [anyChecked, setAnyChecked] = useState(true);

  useLayoutEffect(() => {
    const found = groupRef.current?.querySelector('[role=radio][aria-checked="true"]') != null;
    if (found !== anyChecked) setAnyChecked(found);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cards = enabledItems(groupRef.current, "[role=radio]");
    const next = rovingIndex(e.key, cards.indexOf(document.activeElement as HTMLElement), cards.length, "both");
    if (next === null) return;
    e.preventDefault();
    const target = cards[next];
    target.focus();
    if (target.dataset.cvChoice !== undefined) onChange(target.dataset.cvChoice as T);
  };

  const context: ChoiceGroupContextValue = { value, anyChecked, onChange: (next) => onChange(next as T) };
  return (
    <div ref={setRef} role="radiogroup" onKeyDown={onKeyDown} className={cx("grid gap-2 p-[3px]", COLUMNS[columns], className)} {...rest}>
      <ChoiceGroupContext.Provider value={context}>{children}</ChoiceGroupContext.Provider>
    </div>
  );
}

export interface ChoiceCardProps extends Omit<ComponentPropsWithRef<"button">, "value" | "children"> {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  /** A preview above the label (scheme swatch, icon strip). */
  children?: ReactNode;
}

export function ChoiceCard({ value, label, description, children, className, disabled, ...rest }: ChoiceCardProps) {
  const group = useContext(ChoiceGroupContext);
  const checked = group?.value === value;
  const focusable = checked || group?.anyChecked === false;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={focusable ? 0 : -1}
      data-cv-choice={value}
      data-selected={checked ? "" : undefined}
      disabled={disabled}
      onClick={() => group?.onChange(value)}
      className={cx(
        "flex flex-col gap-1.5 rounded-md border p-2 text-left disabled:opacity-40",
        checked ? "border-accent bg-selected-inactive" : "border-card-border bg-transparent hover:border-(--c-control-border)",
        className,
      )}
      {...rest}
    >
      {children}
      <span className="text-label font-semibold text-ink">{label}</span>
      {description && <span className="text-meta text-ink-muted">{description}</span>}
    </button>
  );
}
