import { useCallback } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useLayoutStore, type LayoutNode, type LayoutBranch } from "../../stores/layoutStore";
import Pane from "./Pane";

/** The separator's own direction: panes side by side are divided by a vertical bar. */
function sashOrientation(direction: LayoutBranch["direction"]): "vertical" | "horizontal" {
  return direction === "horizontal" ? "vertical" : "horizontal";
}

/** Which window edges a node touches: panes along the top carry the title bar, the top-left one the window buttons. */
export interface PaneEdges {
  top: boolean;
  left: boolean;
}

const WINDOW_EDGES: PaneEdges = { top: true, left: true };

/** The edges each child of a split keeps: the second child of a side-by-side split leaves the left edge, of a stacked split the top. */
export function childEdges(direction: LayoutBranch["direction"], edges: PaneEdges): [PaneEdges, PaneEdges] {
  return direction === "horizontal"
    ? [edges, { top: edges.top, left: false }]
    : [edges, { top: false, left: edges.left }];
}

interface LayoutRendererProps {
  node: LayoutNode;
  rightSlot?: React.ReactNode;
  edges?: PaneEdges;
}

export default function LayoutRenderer({ node, rightSlot, edges = WINDOW_EDGES }: LayoutRendererProps) {
  if (node.type === "leaf") {
    return <Pane paneId={node.id} rightSlot={rightSlot} edges={edges} />;
  }

  return <BranchRenderer node={node} rightSlot={rightSlot} edges={edges} />;
}

function BranchRenderer({ node, rightSlot, edges }: { node: LayoutBranch; rightSlot?: React.ReactNode; edges: PaneEdges }) {
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

  const [edges0, edges1] = childEdges(node.direction, edges);

  return (
    <Group orientation={node.direction} onLayoutChanged={handleLayoutChanged}>
      <Panel
        id={childId0}
        defaultSize={`${node.sizes[0]}%`}
        minSize="10%"
      >
        <LayoutRenderer node={node.children[0]} rightSlot={rightSlot} edges={edges0} />
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
        <LayoutRenderer node={node.children[1]} rightSlot={rightSlot} edges={edges1} />
      </Panel>
    </Group>
  );
}
