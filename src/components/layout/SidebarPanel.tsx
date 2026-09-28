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
    ? "relative z-30 flex-shrink-0"
    : `fixed top-0 bottom-0 left-0 z-40 ${motion}`;

  // Element order stays fixed across modes so pinning never remounts the tree.
  return (
    <>
      {!docked && (
        <div
          className={`fixed inset-0 z-30 transition-opacity duration-200 ${closing ? "bg-black/0" : "bg-black/20"}`}
          onClick={onBackdropClick}
        />
      )}
      <div
        data-sidebar-panel
        data-docked={docked ? "" : undefined}
        className={`${frame} flex flex-col bg-canvas border-r border-stroke`}
        style={docked ? { width } : { width, boxShadow: "6px 0 20px rgba(0,0,0,0.08)" }}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setSlideIn(false);
        }}
      >
        {/* Accent bar — continues the app-level top bar */}
        {!docked && <div className="h-[2px] bg-conduit-500 flex-shrink-0" />}
        {children}
        {/* Resize handle — wide hit area, col-resize cursor, delayed blue highlight; inside the panel when docked */}
        <div
          onMouseDown={onResizeStart}
          className={`absolute top-0 bottom-0 cursor-col-resize group ${docked ? "w-2" : "w-3"}`}
          style={{ right: docked ? 0 : -6 }}
        >
          <div className={`absolute top-0 bottom-0 w-[3px] rounded-full transition-colors ${docked ? "right-0" : "right-1.5"} ${
            resizeActive
              ? "bg-conduit-500/70 duration-0"
              : "bg-transparent duration-200 group-hover:bg-conduit-500/50 group-hover:duration-200 group-hover:delay-[600ms]"
          }`} />
        </div>
      </div>
    </>
  );
}
