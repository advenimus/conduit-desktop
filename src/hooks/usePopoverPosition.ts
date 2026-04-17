import { useState, useLayoutEffect, useCallback, type RefObject } from "react";

interface PopoverSize {
  width: number;
  height: number;
}

interface PopoverPosition {
  top: number;
  left: number;
}

const EDGE_PADDING = 8;
const GAP = 4;

export function usePopoverPosition(
  triggerRef: RefObject<HTMLElement | null>,
  contentSize: PopoverSize,
): PopoverPosition {
  const [pos, setPos] = useState<PopoverPosition>({ top: 0, left: 0 });

  const calculate = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();

    let top = rect.bottom + GAP;
    let left = rect.left;

    // Flip above if would overflow viewport bottom
    if (top + contentSize.height > window.innerHeight - EDGE_PADDING) {
      top = rect.top - contentSize.height - GAP;
    }

    // Clamp to top edge after flip
    if (top < EDGE_PADDING) {
      top = EDGE_PADDING;
    }

    // Shift left if would overflow viewport right
    if (left + contentSize.width > window.innerWidth - EDGE_PADDING) {
      left = window.innerWidth - contentSize.width - EDGE_PADDING;
    }

    // Don't let it go off the left edge
    if (left < EDGE_PADDING) {
      left = EDGE_PADDING;
    }

    setPos({ top, left });
  }, [triggerRef, contentSize.width, contentSize.height]);

  useLayoutEffect(() => {
    calculate();
    window.addEventListener("resize", calculate);
    window.addEventListener("scroll", calculate, { capture: true });
    return () => {
      window.removeEventListener("resize", calculate);
      window.removeEventListener("scroll", calculate, { capture: true });
    };
  }, [calculate]);

  return pos;
}
