import { useEffect, useRef } from "react";

export type ContextMenuItem =
  | { label: string; onClick: () => void; variant?: "danger"; icon?: React.ReactNode; type?: never }
  | { type: "separator"; label?: never; onClick?: never; variant?: never; icon?: never };

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Notify native webviews to hide while context menu is open
  useEffect(() => {
    document.dispatchEvent(
      new CustomEvent("conduit:context-menu-change", { detail: true })
    );
    return () => {
      document.dispatchEvent(
        new CustomEvent("conduit:context-menu-change", { detail: false })
      );
    };
  }, []);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Adjust position so menu doesn't overflow viewport
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menuRef.current.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menuRef.current.style.top = `${y - rect.height}px`;
    }
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      data-context-menu
      className="fixed z-50 min-w-[160px] bg-panel border border-stroke-dim rounded-lg shadow-lg py-1 overflow-hidden"
      style={{ left: x, top: y }}
    >
      {items.map((item, idx) => {
        if (item.type === "separator") {
          return (
            <div key={`sep-${idx}`} className="my-1 border-t border-stroke" />
          );
        }

        return (
          <button
            key={item.label}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
              item.variant === "danger"
                ? "text-red-400 hover:bg-red-500/20"
                : "text-ink hover:bg-raised"
            }`}
          >
            {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
