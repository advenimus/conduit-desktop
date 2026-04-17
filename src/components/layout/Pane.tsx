import { useCallback } from "react";
import { useLayoutStore } from "../../stores/layoutStore";
import PaneTabBar from "./PaneTabBar";
import PaneContent from "./PaneContent";
import DropZoneOverlay from "./DropZoneOverlay";

interface PaneProps {
  paneId: string;
  rightSlot?: React.ReactNode;
}

export default function Pane({ paneId, rightSlot }: PaneProps) {
  const isFocused = useLayoutStore((s) => s.focusedPaneId === paneId);

  const handleFocus = useCallback(() => {
    useLayoutStore.getState().setFocusedPane(paneId);
  }, [paneId]);

  return (
    <div
      className="flex flex-col h-full w-full relative"
      onMouseDown={handleFocus}
    >
      <PaneTabBar paneId={paneId} isFocused={isFocused} rightSlot={isFocused ? rightSlot : undefined} />
      <div
        className="flex flex-col flex-1 min-h-0 min-w-0 relative overflow-hidden"
        data-content-area={isFocused ? "" : undefined}
      >
        <PaneContent paneId={paneId} isFocused={isFocused} />
        <DropZoneOverlay paneId={paneId} />
      </div>
    </div>
  );
}
