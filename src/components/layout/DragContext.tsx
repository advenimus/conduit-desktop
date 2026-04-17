import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { invoke } from "../../lib/electron";

interface DragContextValue {
  draggedSessionId: string | null;
  dragSourcePaneId: string | null;
  startDrag: (sessionId: string, paneId: string) => void;
  endDrag: () => void;
}

const DragContext = createContext<DragContextValue>({
  draggedSessionId: null,
  dragSourcePaneId: null,
  startDrag: () => {},
  endDrag: () => {},
});

export function DragProvider({ children }: { children: ReactNode }) {
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dragSourcePaneId, setDragSourcePaneId] = useState<string | null>(null);
  const draggingRef = useRef(false);

  const startDrag = useCallback((sessionId: string, paneId: string) => {
    setDraggedSessionId(sessionId);
    setDragSourcePaneId(paneId);
    draggingRef.current = true;
    // Hide ALL native web session views so HTML drop zones are reachable.
    // Deferred to next tick: removing native HWNDs (WebContentsView) during
    // dragstart can trigger WM_CAPTURECHANGED on Windows, which releases
    // mouse capture and cancels the OLE drag-and-drop operation.
    setTimeout(() => {
      invoke("web_session_hide_all").catch(() => {});
    }, 0);
    // Notify WebView components to track drag state for restore
    document.dispatchEvent(
      new CustomEvent("conduit:drag-change", { detail: true }),
    );
  }, []);

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDraggedSessionId(null);
    setDragSourcePaneId(null);
    // Notify WebView components to restore native views
    document.dispatchEvent(
      new CustomEvent("conduit:drag-change", { detail: false }),
    );
  }, []);

  // Safety net: document-level dragend always fires even if source element is destroyed.
  // This ensures drag state is cleared if the source pane collapsed during the drop.
  useEffect(() => {
    const handleDragEnd = () => {
      if (draggingRef.current) {
        endDrag();
      }
    };
    document.addEventListener("dragend", handleDragEnd);
    return () => document.removeEventListener("dragend", handleDragEnd);
  }, [endDrag]);

  return (
    <DragContext.Provider value={{ draggedSessionId, dragSourcePaneId, startDrag, endDrag }}>
      {children}
    </DragContext.Provider>
  );
}

export function useDragContext() {
  return useContext(DragContext);
}
