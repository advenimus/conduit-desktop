import { useState, useRef, useEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ICON_CATEGORIES } from "./iconRegistry";
import { usePopoverPosition } from "../../hooks/usePopoverPosition";
import { CloseIcon, SearchIcon } from "../../lib/icons";

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

  return createPortal(
    <div
      ref={ref}
      data-popover
      className="fixed z-[60] bg-panel border border-stroke rounded-lg shadow-xl w-[300px] flex flex-col"
      style={{ top: pos.top, left: pos.left, maxHeight: "360px" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-medium text-ink-muted">Icon</span>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-raised">
          <CloseIcon size={12} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <SearchIcon size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search icons..."
            className="w-full pl-7 pr-2 py-1.5 bg-well border border-stroke rounded text-xs focus:outline-none focus:ring-1 focus:ring-conduit-500"
          />
        </div>
      </div>

      {/* Use Default button */}
      <div className="px-3 pb-2">
        <button
          onClick={() => { onSelect(null); onClose(); }}
          className={`w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
            value === null ? "bg-conduit-600/20 text-conduit-400" : "text-ink-secondary hover:bg-raised"
          }`}
        >
          Use Default
        </button>
      </div>

      {/* Icon grid */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {filteredCategories.map((cat) => (
          <div key={cat.label} className="mb-3">
            <p className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider mb-1.5">
              {cat.label}
            </p>
            <div className="grid grid-cols-6 gap-1">
              {cat.icons.map(({ name, component: IconComp }) => (
                <button
                  key={name}
                  onClick={() => { onSelect(name); onClose(); }}
                  className={`w-9 h-9 flex items-center justify-center rounded transition-all ${
                    value === name
                      ? "bg-conduit-600/20 ring-1 ring-conduit-500"
                      : "hover:bg-raised"
                  }`}
                  title={name.replace(/^Icon/, "")}
                >
                  <IconComp size={18} style={iconStyle} />
                </button>
              ))}
            </div>
          </div>
        ))}
        {filteredCategories.length === 0 && (
          <p className="text-xs text-ink-faint text-center py-4">No icons match "{search}"</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
