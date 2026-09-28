import type { HTMLAttributes, MouseEventHandler, ReactElement, ReactNode, Ref } from "react";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

/** A semantic icon name, an icon component, or any element (an entry icon in its own color). */
export type RowLeadingContent = IconSource | ReactElement;

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, "onClick"> {
  /** Makes the row a <button>. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  ref?: Ref<HTMLElement>;
  selected?: boolean;
  /** Selected in a list that does not have focus. */
  inactive?: boolean;
  leading?: RowLeadingContent;
  /** Small IconButtons, shown on hover or focus-within and hidden with opacity only (B45). */
  trailing?: ReactNode;
  /** A second line; the row becomes 36px. */
  description?: ReactNode;
}

const ARIA_SELECTED_ROLES = new Set(["option", "treeitem", "row", "gridcell", "tab"]);

export function rowStateClasses(selected: boolean, inactive: boolean): string {
  if (!selected) return "text-ink-secondary hover:bg-hover";
  return inactive ? "bg-selected-inactive text-ink" : "bg-selected text-ink";
}

/** aria-selected inside a listbox, tree or grid; data-selected elsewhere. Both trigger the 2.11 re-scope. */
export function selectionAttributes(selected: boolean, role: string | undefined): Record<string, string> {
  if (!selected) return {};
  return role && ARIA_SELECTED_ROLES.has(role) ? { "aria-selected": "true" } : { "data-selected": "" };
}

function isIconSource(value: RowLeadingContent): value is IconSource {
  return typeof value === "string" || typeof value === "function" || !("props" in value);
}

export function RowLeading({ leading }: { leading?: RowLeadingContent }) {
  if (leading === undefined) return null;
  return <span className="flex size-4 shrink-0 items-center justify-center">{isIconSource(leading) ? <IconSlot icon={leading} /> : leading}</span>;
}

export function RowTrailing({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
      {children}
    </span>
  );
}

/**
 * A 22px row (36px with a description), spec 4.14. Clickable rows are a <button> (B44); a clickable row
 * with trailing actions wraps that button, so no button sits inside another.
 */
export function ListRow({
  selected = false,
  inactive = false,
  leading,
  trailing,
  description,
  onClick,
  disabled,
  role,
  className,
  children,
  ref,
  ...rest
}: ListRowProps) {
  const rowBox = cx("flex w-full min-w-0 items-center gap-1.5 rounded px-2 text-left text-body disabled:opacity-40", description ? "h-row-2line" : "h-row");
  const state = rowStateClasses(selected, inactive);
  const selection = selectionAttributes(selected, role);
  const content = (
    <>
      <RowLeading leading={leading} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {description && <span className="truncate text-meta text-ink-muted">{description}</span>}
      </span>
    </>
  );

  if (!onClick) {
    return (
      <div ref={ref as Ref<HTMLDivElement>} role={role} {...selection} className={cx("group/row", rowBox, state, className)} {...rest}>
        {content}
        {trailing && <RowTrailing>{trailing}</RowTrailing>}
      </div>
    );
  }

  if (!trailing) {
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        role={role}
        disabled={disabled}
        onClick={onClick}
        {...selection}
        className={cx("group/row", rowBox, state, className)}
        {...rest}
      >
        {content}
      </button>
    );
  }

  return (
    <div role={role} {...selection} className={cx("group/row relative flex min-w-0 items-center rounded pr-1", state)}>
      <button ref={ref as Ref<HTMLButtonElement>} type="button" disabled={disabled} onClick={onClick} className={cx(rowBox, "flex-1", className)} {...rest}>
        {content}
      </button>
      <RowTrailing>{trailing}</RowTrailing>
    </div>
  );
}
