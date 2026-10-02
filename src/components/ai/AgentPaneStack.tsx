import { Fragment, useRef, useState, type PointerEvent } from "react";
import { useAgentPaneStore } from "../../stores/agentPaneStore";
import AgentPane from "./AgentPane";

const MIN_PANE_PX = 96;

interface Sizes {
  /** The pane ids the weights were measured for; any add or close resets to an equal split. */
  key: string;
  weights: readonly number[];
}

interface Drag {
  index: number;
  startY: number;
  heights: readonly number[];
}

export default function AgentPaneStack({ epoch }: { epoch: number }) {
  const panes = useAgentPaneStore((s) => s.panes);
  const focusedPaneId = useAgentPaneStore((s) => s.focusedPaneId);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [sizes, setSizes] = useState<Sizes | null>(null);

  const key = panes.map((p) => p.id).join(" ");
  const weights = sizes?.key === key ? sizes.weights : panes.map(() => 1);

  const startDrag = (index: number) => (e: PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const heights = [...container.querySelectorAll<HTMLElement>(":scope > [data-agent-pane]")].map((el) => el.getBoundingClientRect().height);
    dragRef.current = { index, startY: e.clientY, heights };
    setDragging(index);
  };

  const moveDrag = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { index, startY, heights } = drag;
    const pair = heights[index] + heights[index + 1];
    const upper = Math.min(Math.max(heights[index] + e.clientY - startY, MIN_PANE_PX), pair - MIN_PANE_PX);
    setSizes({ key, weights: heights.map((h, i) => (i === index ? upper : i === index + 1 ? pair - upper : h)) });
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    setDragging(null);
  };

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      {panes.map((pane, index) => (
        <Fragment key={pane.id}>
          {index > 0 && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize agents"
              data-orientation="horizontal"
              data-dragging={dragging === index - 1 ? "" : undefined}
              className="cv-split-sash cv-split-sash-ai"
              onPointerDown={startDrag(index - 1)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          )}
          <AgentPane
            pane={pane}
            epoch={epoch}
            focused={pane.id === focusedPaneId}
            showHeader={panes.length > 1}
            style={{ flexGrow: weights[index] }}
          />
        </Fragment>
      ))}
    </div>
  );
}
