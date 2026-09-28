import { useRef, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";
import { useMergedRef } from "./refs";
import { enabledItems, rovingIndex } from "./roving";

export interface TabItem<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: IconSource;
  disabled?: boolean;
}

export type TabsVariant = "panel" | "underline";

export interface TabsProps<T extends string> extends Omit<ComponentPropsWithRef<"div">, "onChange"> {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  variant?: TabsVariant;
  /** Links each tab to the TabPanel with the same idBase and value (aria-controls). */
  idBase?: string;
}

const STRIP: Readonly<Record<TabsVariant, string>> = {
  panel: "flex h-part-title items-center gap-1 px-1",
  underline: "flex h-part-title items-end gap-4 border-b border-divider px-2",
};

function tabClasses(variant: TabsVariant, selected: boolean): string {
  if (variant === "underline") {
    return cx(
      "-mb-px flex h-full items-center gap-1.5 border-b-2 px-0 text-body disabled:opacity-40",
      selected ? "border-(--c-tab-underline) text-(--c-tab-fg-active)" : "border-transparent text-(--c-tab-fg) hover:text-(--c-tab-fg-hover)",
    );
  }
  return cx(
    "flex h-6 items-center gap-1.5 rounded px-2.5 text-body disabled:opacity-40",
    selected ? "bg-selected-inactive text-(--c-tab-fg-active)" : "text-(--c-tab-fg) hover:bg-hover hover:text-(--c-tab-fg-hover)",
  );
}

export const tabId = (idBase: string, value: string) => `${idBase}-tab-${value}`;
export const tabPanelId = (idBase: string, value: string) => `${idBase}-panel-${value}`;

/** role=tablist with automatic activation: Left, Right, Home and End move and select (spec 4.7). */
export function Tabs<T extends string>({ items, value, onChange, variant = "panel", idBase, className, ref, ...rest }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const setRef = useMergedRef(listRef, ref);
  const hasSelected = items.some((i) => i.value === value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tabs = enabledItems(listRef.current, "[role=tab]");
    const next = rovingIndex(e.key, tabs.indexOf(document.activeElement as HTMLElement), tabs.length, "horizontal");
    if (next === null) return;
    e.preventDefault();
    const target = tabs[next];
    target.focus();
    const item = items.find((i) => i.value === target.dataset.value);
    if (item) onChange(item.value);
  };

  return (
    <div ref={setRef} role="tablist" onKeyDown={onKeyDown} className={cx(STRIP[variant], className)} {...rest}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={idBase ? tabId(idBase, item.value) : undefined}
            aria-controls={idBase ? tabPanelId(idBase, item.value) : undefined}
            aria-selected={selected}
            tabIndex={selected || (!hasSelected && index === 0) ? 0 : -1}
            disabled={item.disabled}
            data-value={item.value}
            onClick={() => onChange(item.value)}
            className={tabClasses(variant, selected)}
          >
            {item.icon && <IconSlot icon={item.icon} className="shrink-0" />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps extends ComponentPropsWithRef<"div"> {
  idBase: string;
  value: string;
}

export function TabPanel({ idBase, value, children, ...rest }: TabPanelProps) {
  return (
    <div role="tabpanel" id={tabPanelId(idBase, value)} aria-labelledby={tabId(idBase, value)} {...rest}>
      {children}
    </div>
  );
}
