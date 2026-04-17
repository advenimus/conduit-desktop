import type { ReactNode } from "react";
import { useLayoutStore } from "../../stores/layoutStore";
import { DragProvider } from "./DragContext";
import LayoutRenderer from "./LayoutRenderer";

interface SplitContainerProps {
  rightSlot?: ReactNode;
}

export default function SplitContainer({ rightSlot }: SplitContainerProps) {
  const root = useLayoutStore((s) => s.root);

  return (
    <DragProvider>
      <div className="flex flex-col flex-1 min-h-0 min-w-0">
        <LayoutRenderer node={root} rightSlot={rightSlot} />
      </div>
    </DragProvider>
  );
}
