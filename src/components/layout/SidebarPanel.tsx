import { useState, type ReactNode } from "react";

interface SidebarPanelProps {
  docked: boolean;
  closing: boolean;
  width: number;
  resizeActive: boolean;
  onBackdropClick: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
  children: ReactNode;
}

export default function SidebarPanel({
  docked,
  closing,
  width,
  resizeActive,
  onBackdropClick,
  onResizeStart,
  children,
}: SidebarPanelProps) {
  // Unpinning an open sidebar must not replay the slide-in.
  const [slideIn, setSlideIn] = useState(!docked);
  if (docked && slideIn) setSlideIn(false);

  const motion = closing ? "animate-sidebar-out" : slideIn ? "animate-sidebar-in" : "";
  const frame = docked
    ? "relative z-30 order-first flex-shrink-0"
    : `fixed top-0 bottom-0 left-0 z-40 shadow-overlay ${motion}`;

  // Element order stays fixed across modes so pinning never remounts the tree.
  return (
    <>
      {!docked && (
        <div
          className={`fixed inset-0 z-30 transition-[background-color] duration-200 ${closing ? "bg-transparent" : "bg-(--c-scrim-sidebar)"}`}
          onClick={onBackdropClick}
        />
      )}
      <div
        data-sidebar-panel
        data-docked={docked ? "" : undefined}
        className={`${frame} flex flex-col bg-sidebar border-r border-divider`}
        style={{ width }}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setSlideIn(false);
        }}
      >
        {!docked && <div data-cv-accent-line className="h-[2px] shrink-0 bg-accent" />}
        {children}
        <div
          data-cv-sidebar-resize=""
          onMouseDown={onResizeStart}
          className={`absolute top-0 bottom-0 cursor-col-resize group ${docked ? "w-2" : "w-3"}`}
          style={{ right: docked ? 0 : -6 }}
        >
          <div className={`absolute top-0 bottom-0 w-1 transition-[background-color] ${docked ? "right-0" : "right-1.5"} ${
            resizeActive
              ? "bg-accent duration-0"
              : "bg-transparent duration-100 group-hover:bg-accent group-hover:delay-300"
          }`} />
        </div>
      </div>
    </>
  );
}
