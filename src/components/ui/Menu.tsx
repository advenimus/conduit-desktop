import { createContext, useContext, useLayoutEffect, useRef, type ComponentPropsWithRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";
import { useMergedRef } from "./refs";
import { enabledItems, rovingIndex } from "./roving";

interface MenuContextValue {
  close: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

const ITEM_SELECTOR = "[role=menuitem]";
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const TYPEAHEAD_RESET_MS = 500;

export interface MenuProps extends ComponentPropsWithRef<"div"> {
  /** Called after an item is chosen (unless the item keeps the menu open). */
  onClose?: () => void;
  /** Focus the first item when the menu mounts (default). */
  autoFocus?: boolean;
}

/**
 * DOM menu (spec 4.10), rendered inside a Popover (padding={false}). Up, Down, Home, End and typeahead
 * move between items; Enter and Space are the buttons' own; Escape belongs to the Popover's layer.
 */
export function Menu({ onClose, autoFocus = true, className, children, onKeyDown, ref, ...rest }: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const setRef = useMergedRef(menuRef, ref);
  const typeahead = useRef({ text: "", at: 0 });

  useLayoutEffect(() => {
    if (autoFocus) enabledItems(menuRef.current, ITEM_SELECTOR)[0]?.focus();
    // Only on mount: later renders must not pull focus back to the first item.
  }, []);

  const moveByTypeahead = (key: string, items: HTMLElement[], current: number) => {
    const now = Date.now();
    const state = typeahead.current;
    const text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key;
    typeahead.current = { text, at: now };
    const needle = text.toLowerCase();
    const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
    ordered.find((item) => (item.textContent ?? "").trim().toLowerCase().startsWith(needle))?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    // A field inside the menu (a custom model id) keeps its own keys: typeahead would swallow the text.
    if ((e.target as Element).closest(EDITABLE_SELECTOR)) return;
    const items = enabledItems(menuRef.current, ITEM_SELECTOR);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = rovingIndex(e.key, current, items.length, "vertical");
    if (next !== null) {
      e.preventDefault();
      items[next].focus();
      return;
    }
    if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      moveByTypeahead(e.key, items, current);
    }
  };

  return (
    <MenuContext.Provider value={{ close: () => onClose?.() }}>
      <div ref={setRef} role="menu" onKeyDown={handleKeyDown} className={cx("min-w-[160px] py-1", className)} {...rest}>
        {children}
      </div>
    </MenuContext.Provider>
  );
}

export interface MenuItemProps extends Omit<ComponentPropsWithRef<"button">, "onSelect"> {
  onSelect: () => void;
  icon?: IconSource;
  danger?: boolean;
  /** Keep the menu open after this item runs (toggles). */
  keepOpen?: boolean;
  /** Content after the label, right-aligned (a check mark, a shortcut). */
  end?: ReactNode;
}

/** A <button role="menuitem">: the harness clicks menu items with selector `button` (B43). */
export function MenuItem({ onSelect, icon, danger = false, keepOpen = false, end, className, children, onMouseEnter, ...rest }: MenuItemProps) {
  const menu = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => {
        onSelect();
        if (!keepOpen) menu?.close();
      }}
      onMouseEnter={(e) => {
        onMouseEnter?.(e);
        if (!e.currentTarget.disabled) e.currentTarget.focus();
      }}
      className={cx(
        "mx-1 flex h-6 w-[calc(100%-8px)] items-center gap-2 rounded-md px-2 text-left text-body disabled:opacity-40",
        "focus:outline focus:outline-1 focus:-outline-offset-1 focus:outline-(--c-menu-selection-border)",
        danger ? "text-danger focus:bg-(--c-menu-danger-hover-bg)" : "text-ink-secondary focus:bg-(--c-menu-selection-bg)",
        className,
      )}
      {...rest}
    >
      {icon && <IconSlot icon={icon} className={cx("shrink-0", danger ? "text-danger" : "text-ink-muted")} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end}
    </button>
  );
}

export function MenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cx("my-[5px] h-px bg-divider", className)} />;
}

export function MenuHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="presentation" className={cx("flex h-6 items-center px-3 text-meta font-semibold text-ink-muted", className)}>
      {children}
    </div>
  );
}
