import { useState, useRef, useEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ICON_CATEGORIES, resolveIcon } from "./iconRegistry";
import { usePopoverPosition } from "../../hooks/usePopoverPosition";
import { IconButton, SearchInput, cx, useLayer } from "../ui";
import { PICKER_PANEL, PICKER_TITLE, defaultRowClass } from "./pickerChrome";

interface IconPickerProps {
  value: string | null;
  onSelect: (icon: string | null) => void;
  onClose: () => void;
  customColor?: string | null;
  anchorRef: RefObject<HTMLElement | null>;
}

const PICKER_SIZE = { width: 300, height: 360 };

export default function IconPicker({ value, onSelect, onClose, customColor, anchorRef }: IconPickerProps) {
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pos = usePopoverPosition(anchorRef, PICKER_SIZE);
  // Above the dialog that opened it, so Tab reaches the picker; Escape does nothing here, as before.
  useLayer({ ref });

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current && !ref.current.contains(target) &&
          anchorRef.current && !anchorRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose, anchorRef]);

  const query = search.toLowerCase().replace(/^icon/, "");

  const filteredCategories = ICON_CATEGORIES.map((cat) => ({
    ...cat,
    icons: cat.icons.filter((i) =>
      i.name.toLowerCase().replace(/^icon/, "").includes(query)
    ),
  })).filter((cat) => cat.icons.length > 0);

  const iconStyle = customColor ? { color: customColor } : undefined;

  const pick = (icon: string | null) => {
    onSelect(icon);
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      data-popover
      className={cx(PICKER_PANEL, "flex w-[300px] flex-col")}
      style={{ top: pos.top, left: pos.left, maxHeight: "360px" }}
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <span className={PICKER_TITLE}>Icon</span>
        <IconButton size="sm" icon="close" label="Close" onClick={onClose} />
      </div>

      <div className="px-3 pb-2">
        <SearchInput ref={searchRef} value={search} onChange={setSearch} placeholder="Search icons..." />
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => pick(null)}
          {...(value === null ? { "data-selected": "" } : {})}
          className={defaultRowClass(value === null)}
        >
          Use Default
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {filteredCategories.map((cat) => (
          <div key={cat.label} className="mb-3">
            <p className="mb-1.5 text-meta font-semibold text-ink-muted">{cat.label}</p>
            <div className="grid grid-cols-6 gap-1">
              {cat.icons.map(({ name }) => {
                const IconComp = resolveIcon(name);
                const selected = value === name;
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => pick(name)}
                    {...(selected ? { "data-selected": "" } : {})}
                    className={cx(
                      "flex size-9 items-center justify-center rounded",
                      selected ? "bg-selected outline outline-1 -outline-offset-1 outline-(--c-accent)" : "hover:bg-hover",
                    )}
                    title={name.replace(/^Icon/, "")}
                  >
                    {IconComp && <IconComp size={20} style={iconStyle} />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {filteredCategories.length === 0 && (
          <p className="py-4 text-center text-meta text-ink-muted">No icons match "{search}"</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
