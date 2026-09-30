import { useRef, useState, type ComponentPropsWithRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "../../lib/icons";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";
import { useMergedRef } from "./refs";
import { enabledItems, rovingIndex } from "./roving";

export interface NavItem {
  kind?: "item";
  id: string;
  label: string;
  icon?: IconSource;
}

export interface NavGroup {
  kind: "group";
  id: string;
  label: string;
  icon?: IconSource;
  children: ReadonlyArray<NavItem>;
  defaultExpanded?: boolean;
}

export interface NavLabel {
  kind: "label";
  id: string;
  label: string;
}

export type NavEntry = NavItem | NavGroup | NavLabel;

export interface NavListProps extends Omit<ComponentPropsWithRef<"nav">, "onChange"> {
  items: ReadonlyArray<NavEntry>;
  value: string;
  onChange: (id: string) => void;
}

const ROW = "flex h-7 w-full items-center gap-2 rounded text-left text-body";

function rowState(selected: boolean): string {
  return selected ? "bg-selected text-ink" : "text-ink-secondary hover:bg-hover";
}

function groupButton(nav: HTMLElement | null, id: string | undefined): HTMLElement | undefined {
  return Array.from(nav?.querySelectorAll<HTMLElement>("[data-nav-group]") ?? []).find((el) => el.dataset.navGroup === id);
}

function selectedProps(selected: boolean) {
  return selected ? { "data-selected": "" } : {};
}

/**
 * Settings-style navigation (spec 4.7): buttons with aria-current="page". Up, Down, Home and End move
 * focus; Right opens a group and Left closes it or returns to it from a child.
 */
export function NavList({ items, value, onChange, className, ref, ...rest }: NavListProps) {
  const navRef = useRef<HTMLElement>(null);
  const setRef = useMergedRef(navRef, ref);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(items.flatMap((e) => (e.kind === "group" && e.defaultExpanded ? [e.id] : []))),
  );

  const setGroup = (id: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const active = document.activeElement as HTMLElement | null;
    const groupId = active?.dataset.navGroup;
    const parentId = active?.dataset.navParent;
    if (e.key === "ArrowRight" && groupId) {
      e.preventDefault();
      setGroup(groupId, true);
      return;
    }
    if (e.key === "ArrowLeft" && (groupId || parentId)) {
      e.preventDefault();
      if (groupId) setGroup(groupId, false);
      else groupButton(navRef.current, parentId)?.focus();
      return;
    }
    const rows = enabledItems(navRef.current, "button");
    const next = rovingIndex(e.key, rows.indexOf(active as HTMLElement), rows.length, "vertical");
    if (next === null) return;
    e.preventDefault();
    rows[next].focus();
  };

  const renderItem = (item: NavItem, parent?: string) => {
    const selected = item.id === value;
    return (
      <button
        key={item.id}
        type="button"
        aria-current={selected ? "page" : undefined}
        data-nav-parent={parent}
        {...selectedProps(selected)}
        onClick={() => onChange(item.id)}
        className={cx(ROW, parent ? "pl-8 pr-2" : "px-2", rowState(selected))}
      >
        {item.icon && <IconSlot icon={item.icon} className="shrink-0" />}
        <span className="min-w-0 truncate">{item.label}</span>
      </button>
    );
  };

  const renderGroup = (group: NavGroup) => {
    const open = expanded.has(group.id);
    const holdsCurrent = group.children.some((c) => c.id === value);
    const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
    return (
      <div key={group.id} className="flex flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={open}
          data-nav-group={group.id}
          {...selectedProps(holdsCurrent && !open)}
          onClick={() => setGroup(group.id, !open)}
          className={cx(ROW, "px-2", rowState(holdsCurrent && !open))}
        >
          {group.icon && <IconSlot icon={group.icon} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          <Chevron size={16} className="shrink-0 text-ink-muted" />
        </button>
        {open && group.children.map((child) => renderItem(child, group.id))}
      </div>
    );
  };

  return (
    <nav ref={setRef} onKeyDown={onKeyDown} className={cx("flex flex-col gap-0.5", className)} {...rest}>
      {items.map((entry) => {
        if (entry.kind === "label") {
          return (
            <div key={entry.id} className="flex h-7 items-center px-2 text-meta font-semibold text-ink-muted">
              {entry.label}
            </div>
          );
        }
        if (entry.kind === "group") return renderGroup(entry);
        return renderItem(entry);
      })}
    </nav>
  );
}
