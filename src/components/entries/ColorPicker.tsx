import { useRef, useEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePopoverPosition } from "../../hooks/usePopoverPosition";
import { IconButton, cx, useLayer } from "../ui";
import { PICKER_PANEL, PICKER_TITLE, defaultRowClass } from "./pickerChrome";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
];

interface ColorPickerProps {
  value: string | null;
  onSelect: (color: string | null) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}

const PICKER_SIZE = { width: 220, height: 160 };

export default function ColorPicker({ value, onSelect, onClose, anchorRef }: ColorPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(anchorRef, PICKER_SIZE);
  // Above the dialog that opened it, so Tab reaches the picker; Escape does nothing here, as before.
  useLayer({ ref });

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

  const pick = (color: string | null) => {
    onSelect(color);
    onClose();
  };

  return createPortal(
    <div ref={ref} data-popover className={cx(PICKER_PANEL, "w-[220px] p-3")} style={{ top: pos.top, left: pos.left }}>
      <div className="mb-2 flex items-center justify-between">
        <span className={PICKER_TITLE}>Color</span>
        <IconButton size="sm" icon="close" label="Close" onClick={onClose} />
      </div>

      <button
        type="button"
        onClick={() => pick(null)}
        {...(value === null ? { "data-selected": "" } : {})}
        className={cx(defaultRowClass(value === null), "mb-2")}
      >
        Use Default
      </button>

      <div className="grid grid-cols-8 gap-1.5">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => pick(color)}
            {...(value === color ? { "data-selected": "" } : {})}
            className={cx(
              "size-6 rounded-full transition-transform duration-100",
              value === color ? "ring-2 ring-(--c-accent) ring-offset-1 ring-offset-(--c-overlay)" : "hover:scale-110",
            )}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
