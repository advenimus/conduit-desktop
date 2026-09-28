import { useCallback } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useLayoutStore, type LayoutNode, type LayoutBranch } from "../../stores/layoutStore";
import Pane from "./Pane";

/** The separator's own direction: panes side by side are divided by a vertical bar. */
function sashOrientation(direction: LayoutBranch["direction"]): "vertical" | "horizontal" {
  return direction === "horizontal" ? "vertical" : "horizontal";
}

interface LayoutRendererProps {
  node: LayoutNode;
  rightSlot?: React.ReactNode;
}

export default function LayoutRenderer({ node, rightSlot }: LayoutRendererProps) {
  if (node.type === "leaf") {
    return <Pane paneId={node.id} rightSlot={rightSlot} />;
  }

  return <BranchRenderer node={node} rightSlot={rightSlot} />;
}

function BranchRenderer({ node, rightSlot }: { node: LayoutBranch; rightSlot?: React.ReactNode }) {
  const childId0 = node.children[0].id;
  const childId1 = node.children[1].id;

  const handleLayoutChanged = useCallback(
    (layout: Record<string, number>) => {
      const first = layout[childId0];
      const second = layout[childId1];
      if (first !== undefined && second !== undefined) {
        useLayoutStore.getState().updateSizes(node.id, [first, second]);
      }
      document.dispatchEvent(new CustomEvent("conduit:layout-changed"));
    },
    [node.id, childId0, childId1],
  );

  return (
    <Group orientation={node.direction} onLayoutChanged={handleLayoutChanged}>
      <Panel
        id={childId0}
        defaultSize={`${node.sizes[0]}%`}
        minSize="10%"
      >
        <LayoutRenderer node={node.children[0]} rightSlot={rightSlot} />
      </Panel>
      <Separator
        className={`cv-split-sash ${node.direction === "horizontal" ? "w-1" : "h-1"}`}
        data-orientation={sashOrientation(node.direction)}
      />
      <Panel
        id={childId1}
        defaultSize={`${node.sizes[1]}%`}
        minSize="10%"
      >
        <LayoutRenderer node={node.children[1]} rightSlot={rightSlot} />
      </Panel>
    </Group>
  );
}
