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
  /** An icon source draws in a 16px box; an element (a 28px icon tile, an entry icon) sizes itself. */
  leading?: RowLeadingContent;
  /** Always visible after the label, inside the clickable button: badges, timestamps, type labels (L-23). */
  meta?: ReactNode;
  /** Small IconButtons or a decorative chevron, shown on hover or focus-within and hidden with opacity only (B45). */
  trailing?: ReactNode;
  /**
   * The trailing actions cover the meta instead of taking their own column: the meta fades out on
   * hover or focus-within, so the row keeps the width and right edge of rows without actions. The
   * actions sit on the Card surface (`bg-well`) so they hide the text under them.
   */
  trailingOverlay?: boolean;
  /** A second line; the row becomes 40px. */
  description?: ReactNode;
  /** A further line under the description (tags); the row then grows to fit. */
  detail?: ReactNode;
}

const ARIA_SELECTED_ROLES = new Set(["option", "treeitem", "row", "gridcell", "tab"]);
// base.css re-scopes these roles by aria-selected; a selected tab needs data-selected as well.
const RESCOPED_ROLES = new Set(["option", "treeitem", "row", "gridcell"]);

export function rowStateClasses(selected: boolean, inactive: boolean): string {
  if (!selected) return "text-ink-secondary hover:bg-hover";
  return inactive ? "bg-selected-inactive text-ink" : "bg-selected text-ink";
}

/** aria-selected inside a listbox, tree or grid; data-selected elsewhere. Both trigger the 2.11 re-scope. */
export function selectionAttributes(selected: boolean, role: string | undefined): Record<string, string> {
  if (!selected) return {};
  if (!role || !ARIA_SELECTED_ROLES.has(role)) return { "data-selected": "" };
  return RESCOPED_ROLES.has(role) ? { "aria-selected": "true" } : { "aria-selected": "true", "data-selected": "" };
}

function isIconSource(value: RowLeadingContent): value is IconSource {
  return typeof value === "string" || typeof value === "function" || !("props" in value);
}

export function RowLeading({ leading }: { leading?: RowLeadingContent }) {
  if (leading === undefined) return null;
  if (!isIconSource(leading)) return <span className="flex shrink-0 items-center justify-center">{leading}</span>;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <IconSlot icon={leading} />
    </span>
  );
}

const REVEAL = "opacity-0 transition-opacity duration-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100";
const OVERLAY =
  "absolute inset-y-0 right-0 rounded-r bg-well pl-1 pr-1.5 group-hover/row:bg-[image:linear-gradient(var(--c-hover),var(--c-hover))]";

export function RowMeta({ children, fades = false }: { children: ReactNode; fades?: boolean }) {
  return (
    <span
      className={cx(
        "flex shrink-0 items-center gap-2 text-meta text-ink-faint",
        fades && "transition-opacity duration-100 group-hover/row:opacity-0 group-focus-within/row:opacity-0",
      )}
    >
      {children}
    </span>
  );
}

export function RowTrailing({ children, overlay = false }: { children: ReactNode; overlay?: boolean }) {
  return <span className={cx("flex shrink-0 items-center gap-0.5", REVEAL, overlay && OVERLAY)}>{children}</span>;
}

/**
 * A 22px row (40px with a description, taller with a detail line), spec 4.14. Clickable rows are a <button> (B44); a clickable row
 * with trailing actions wraps that button, so no button sits inside another.
 */
export function ListRow({
  selected = false,
  inactive = false,
  leading,
  meta,
  trailing,
  trailingOverlay = false,
  description,
  detail,
  onClick,
  disabled,
  role,
  className,
  children,
  ref,
  ...rest
}: ListRowProps) {
  const height = detail ? "h-auto py-1" : description ? "h-row-2line" : "h-row";
  const rowBox = cx(
    "flex w-full min-w-0 items-center rounded text-left text-body disabled:opacity-40",
    description ? "gap-3 px-3" : "gap-1.5 px-2",
    height,
  );
  const state = rowStateClasses(selected, inactive);
  const selection = selectionAttributes(selected, role);
  const overlay = trailingOverlay && Boolean(trailing);
  const content = (
    <>
      <RowLeading leading={leading} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {description && <span className="truncate text-meta text-ink-muted">{description}</span>}
        {detail && <span className="mt-0.5 text-meta text-ink-muted">{detail}</span>}
      </span>
      {meta !== undefined && meta !== null && meta !== false && <RowMeta fades={overlay}>{meta}</RowMeta>}
    </>
  );

  if (!onClick) {
    return (
      <div ref={ref as Ref<HTMLDivElement>} role={role} {...selection} className={cx("group/row", overlay && "relative", rowBox, state, className)} {...rest}>
        {content}
        {trailing && <RowTrailing overlay={overlay}>{trailing}</RowTrailing>}
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
    <div role={role} {...selection} className={cx("group/row relative flex min-w-0 items-center rounded", !overlay && "pr-1", state)}>
      <button ref={ref as Ref<HTMLButtonElement>} type="button" disabled={disabled} onClick={onClick} className={cx(rowBox, "flex-1", className)} {...rest}>
        {content}
      </button>
      <RowTrailing overlay={overlay}>{trailing}</RowTrailing>
    </div>
  );
}
