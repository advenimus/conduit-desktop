import { useRef, useEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePopoverPosition } from "../../hooks/usePopoverPosition";
import { CloseIcon } from "../../lib/icons";

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

  return createPortal(
    <div
      ref={ref}
      data-popover
      className="fixed z-[60] bg-panel border border-stroke rounded-lg shadow-xl p-3 w-[220px]"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-ink-muted">Color</span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-raised"
        >
          <CloseIcon size={12} />
        </button>
      </div>

      <button
        onClick={() => { onSelect(null); onClose(); }}
        className={`w-full text-left text-xs px-2 py-1.5 rounded mb-2 transition-colors ${
          value === null ? "bg-conduit-600/20 text-conduit-400" : "text-ink-secondary hover:bg-raised"
        }`}
      >
        Use Default
      </button>

      <div className="grid grid-cols-8 gap-1.5">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => { onSelect(color); onClose(); }}
            className={`w-6 h-6 rounded-full transition-all ${
              value === color ? "ring-2 ring-conduit-500 ring-offset-1 ring-offset-panel" : "hover:scale-110"
            }`}
            style={{ backgroundColor: color }}
            title={color}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
