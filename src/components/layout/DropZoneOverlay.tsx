import { useState, useRef, useCallback } from "react";
import { useDragContext } from "./DragContext";
import { useLayoutStore } from "../../stores/layoutStore";

type DropZone = "center" | "left" | "right" | "top" | "bottom";

interface DropZoneOverlayProps {
  paneId: string;
}

const zoneStyles: Record<DropZone, string> = {
  center: "inset-0",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
};

function getZone(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;

  // Edges take priority (outer 25%)
  if (x < 0.25) return "left";
  if (x > 0.75) return "right";
  if (y < 0.25) return "top";
  if (y > 0.75) return "bottom";
  return "center";
}

export default function DropZoneOverlay({ paneId }: DropZoneOverlayProps) {
  const { draggedSessionId, endDrag } = useDragContext();
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      setActiveZone(getZone(e.clientX, e.clientY, rect));
    },
    [],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!activeZone || !draggedSessionId) return;

      const layoutStore = useLayoutStore.getState();

      if (activeZone === "center") {
        layoutStore.moveSessionToPane(draggedSessionId, paneId);
      } else {
        const directionMap: Record<string, "horizontal" | "vertical"> = {
          left: "horizontal",
          right: "horizontal",
          top: "vertical",
          bottom: "vertical",
        };
        const positionMap: Record<string, "before" | "after"> = {
          left: "before",
          right: "after",
          top: "before",
          bottom: "after",
        };
        layoutStore.moveSessionToNewSplit(
          draggedSessionId,
          paneId,
          directionMap[activeZone],
          positionMap[activeZone],
        );
      }
      setActiveZone(null);
      // Clear drag state immediately — the source element may be destroyed by pane collapse
      // and dragend would never fire, leaving the overlay stuck and blocking all interaction
      endDrag();
    },
    [activeZone, draggedSessionId, paneId, endDrag],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear if leaving the overlay itself (not entering a child)
    if (e.currentTarget === e.target) {
      setActiveZone(null);
    }
  }, []);

  if (!draggedSessionId) return null;

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-40 overflow-hidden"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {activeZone && (
        <div
          className={`absolute ${zoneStyles[activeZone]} bg-conduit-500/10 border-2 border-conduit-500/30 rounded-sm transition-all duration-100 pointer-events-none`}
        />
      )}
    </div>
  );
}
