import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { usePopoverPosition } from "../../hooks/usePopoverPosition";
import { useFreeze } from "../../lib/native-freeze";
import { cx } from "./cx";
import { useLayer } from "./layers";
import { useMergedRef } from "./refs";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start";

export interface PopoverProps extends Omit<ComponentPropsWithRef<"div">, "children"> {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: PopoverPlacement;
  /** "auto" freezes native web views only while the panel overlaps a pane's [data-cv-session-area] (spec 4.9, D-21). */
  freeze?: "auto" | boolean;
  /** False drops the panel's 4px padding, for a Menu, which brings its own (spec 4.10). */
  padding?: boolean;
  children: ReactNode;
}

interface Size {
  width: number;
  height: number;
}

const EDGE = 8;
const GAP = 4;
// A little longer than --c-motion-close, in case animationend never fires.
const EXIT_FALLBACK_MS = 200;

/**
 * usePopoverPosition places content below the anchor's left edge and flips it above when it does not
 * fit. The other placements hand it an adjusted anchor rectangle instead of duplicating its rules.
 */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  const r = { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
  return { ...r, toJSON: () => r };
}

function placedRect(anchor: DOMRect, placement: PopoverPlacement, size: Size): DOMRect {
  if (placement === "bottom-end") return rect(anchor.right - size.width, anchor.top, size.width, anchor.height);
  if (placement === "top-start" && anchor.top - size.height - GAP >= EDGE) {
    return rect(anchor.left, anchor.top, anchor.width, window.innerHeight - anchor.top);
  }
  return anchor;
}

function usePlacedAnchor(anchorRef: RefObject<HTMLElement | null>, placement: PopoverPlacement, size: RefObject<Size>): RefObject<HTMLElement | null> {
  return useMemo(
    () => ({
      get current() {
        const anchor = anchorRef.current;
        if (!anchor) return null;
        return { getBoundingClientRect: () => placedRect(anchor.getBoundingClientRect(), placement, size.current) } as unknown as HTMLElement;
      },
    }),
    [anchorRef, placement, size],
  );
}

function overlapsSessionArea(panel: HTMLElement): boolean {
  const r = panel.getBoundingClientRect();
  return Array.from(document.querySelectorAll("[data-cv-session-area]")).some((area) => {
    const c = area.getBoundingClientRect();
    return r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
  });
}

/** DOM popover (spec 4.10): portal, layer stack, outside mousedown, pop-in and pop-out motion. */
export function Popover(props: PopoverProps) {
  const [present, setPresent] = useState(props.open);
  if (props.open && !present) setPresent(true);
  if (!present) return null;
  return <PopoverPanel {...props} onExited={() => setPresent(false)} />;
}

function PopoverPanel({
  anchorRef,
  open,
  onClose,
  placement = "bottom-start",
  freeze = "auto",
  padding = true,
  onExited,
  className,
  style,
  children,
  ref,
  ...rest
}: PopoverProps & { onExited: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const setPanelRef = useMergedRef(panelRef, ref);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const [size, setSize] = useState<Size>(sizeRef.current);
  const [overSessionArea, setOverSessionArea] = useState(false);
  const placedAnchor = usePlacedAnchor(anchorRef, placement, sizeRef);
  const pos = usePopoverPosition(placedAnchor, size);

  // Not tied to `open`: the panel still paints while it plays cv-pop-out, and a web view shown again
  // during that time would cover it. The freeze ends when the panel unmounts.
  useFreeze(freeze === true || (freeze === "auto" && overSessionArea), "popover");
  useLayer({ ref: panelRef, onEscape: onClose, active: open });

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const next = { width: panel.offsetWidth, height: panel.offsetHeight };
      if (next.width === sizeRef.current.width && next.height === sizeRef.current.height) return;
      sizeRef.current = next;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (panelRef.current) setOverSessionArea(overlapsSessionArea(panelRef.current));
  }, [pos.top, pos.left, size]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    return () => document.removeEventListener("mousedown", onMouseDown, true);
  }, [open, onClose, anchorRef]);

  useLayoutEffect(() => {
    if (open) return;
    const panel = panelRef.current;
    const active = document.activeElement;
    if (panel && (panel.contains(active) || active === document.body)) anchorRef.current?.focus();
    const timer = window.setTimeout(onExited, EXIT_FALLBACK_MS);
    return () => window.clearTimeout(timer);
    // onExited only unmounts this panel; a new identity must not restart the exit.
  }, [open]);

  const anchorTop = anchorRef.current?.getBoundingClientRect().top ?? 0;
  const origin: CSSProperties["transformOrigin"] = `${pos.top < anchorTop ? "bottom" : "top"} ${placement === "bottom-end" ? "right" : "left"}`;

  return createPortal(
    <div
      ref={setPanelRef}
      aria-hidden={open ? undefined : true}
      inert={!open}
      onAnimationEnd={() => {
        if (!open) onExited();
      }}
      style={{ position: "fixed", top: pos.top, left: pos.left, transformOrigin: origin, ...style }}
      className={cx(
        "z-(--c-z-popover) rounded-lg border border-overlay-border bg-overlay text-ink shadow-overlay",
        padding && "p-1",
        open ? "animate-pop-in" : "pointer-events-none animate-pop-out",
        className,
      )}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  );
}
