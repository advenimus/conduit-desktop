import type { HTMLAttributes, ReactNode, Ref } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "../../lib/icons";
import { cx } from "./cx";
import { RowLeading, RowTrailing, rowStateClasses, type RowLeadingContent } from "./ListRow";

export interface TreeRowProps extends HTMLAttributes<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
  /** 0 for top-level rows; 8px of indent per level. */
  depth: number;
  /** Set for rows that can hold children; leaves leave it undefined and keep an empty twistie slot. */
  expanded?: boolean;
  onToggle?: () => void;
  selected?: boolean;
  inactive?: boolean;
  leading?: RowLeadingContent;
  trailing?: ReactNode;
}

/**
 * A 22px role="treeitem" row (spec 3.5, 4.14). Every row renders the 16px twistie slot, so leaf icons
 * line up with folder icons at the same depth. Roving tabIndex and arrow keys belong to the tree.
 */
export function TreeRow({ depth, expanded, onToggle, selected = false, inactive = false, leading, trailing, className, style, children, ...rest }: TreeRowProps) {
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={selected ? true : undefined}
      className={cx("group/row flex h-row min-w-0 items-center gap-1.5 rounded pr-2 text-body", rowStateClasses(selected, inactive), className)}
      style={{ paddingLeft: `calc(4px + ${depth * 8}px)`, ...style }}
      {...rest}
    >
      <span
        data-twistie=""
        aria-hidden="true"
        onClick={(e) => {
          if (expanded === undefined) return;
          e.stopPropagation();
          onToggle?.();
        }}
        className="flex size-4 shrink-0 items-center justify-center text-ink-muted"
      >
        {expanded !== undefined && <Chevron size={16} />}
      </span>
      <RowLeading leading={leading} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <RowTrailing>{trailing}</RowTrailing>}
    </div>
  );
}
