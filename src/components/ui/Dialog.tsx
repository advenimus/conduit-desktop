import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useFreeze } from "../../lib/native-freeze";
import { cx } from "./cx";
import { DialogBody, DialogContext, DialogFooter, DialogHeader, type DialogContextValue, type DialogTone } from "./DialogParts";
import type { IconSource } from "./IconSlot";
import { useLayer } from "./layers";
import { useMergedRef } from "./refs";

export type DialogSize = "sm" | "md" | "lg" | "xl";
export type DialogLayer = "base" | "sync" | "stacked";

export interface DialogProps extends Omit<ComponentPropsWithRef<"div">, "title" | "onSubmit"> {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  icon?: IconSource;
  tone?: DialogTone;
  size?: DialogSize;
  layer?: DialogLayer;
  /** Also sets aria-label. Only sync-style dialogs pass it: the harness lists [role=dialog][aria-label] (8.3). */
  harnessLabel?: string;
  closeOnScrim?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  footer?: ReactNode;
  hideClose?: boolean;
  /** Wraps header, body and footer in one form, so the footer's submit button is inside it (B31). */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** False renders in place instead of in a portal on document.body. */
  portal?: boolean;
  /** "custom": the children are the whole panel content, built from DialogHeader, DialogBody and DialogFooter. */
  layout?: "standard" | "custom";
}

const LAYER_Z: Readonly<Record<DialogLayer, string>> = {
  base: "z-(--c-z-dialog)",
  sync: "z-(--c-z-dialog-sync)",
  stacked: "z-(--c-z-dialog-stacked)",
};

const WIDTH: Readonly<Record<DialogSize, string>> = {
  sm: "max-w-[400px]",
  md: "max-w-[520px]",
  lg: "max-w-[720px]",
  xl: "max-w-[880px]",
};

/** Modal dialog (spec 4.8): no animation, unmounts when closed, holds a freeze and joins the layer stack. */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <OpenDialog {...props} />;
}

function OpenDialog({
  open: _open,
  onClose,
  title,
  icon,
  tone,
  size = "md",
  layer = "base",
  harnessLabel,
  closeOnScrim = false,
  initialFocusRef,
  footer,
  hideClose = false,
  onSubmit,
  portal = true,
  layout = "standard",
  className,
  children,
  ref,
  ...rest
}: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const setPanelRef = useMergedRef(panelRef, ref);
  // Read during the first render: by the time effects run, an autofocused child already holds focus.
  const [opener] = useState<HTMLElement | null>(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const pressedScrim = useRef(false);
  const focusedAtCleanup = useRef<HTMLElement | null>(null);
  const fallbackTitleId = `${titleId}-title`;
  const [headerMissing, setHeaderMissing] = useState(false);

  useFreeze(true, "dialog", typeof title === "string" ? title : harnessLabel);
  useLayer({ ref: panelRef, onEscape: onClose, trapFocus: true });

  // Focus moves in once on open and back to the opener once on close.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previous = focusedAtCleanup.current;
    focusedAtCleanup.current = null;
    if (previous && panel.contains(previous)) {
      // StrictMode runs the cleanup once right after mounting; put focus back where it was.
      previous.focus();
    } else if (!panel.contains(document.activeElement)) {
      const target = initialFocusRef?.current ?? panel.querySelector<HTMLElement>("[autofocus]") ?? panel;
      target.focus();
    }
    return () => {
      const active = document.activeElement;
      const focusInside = panel.contains(active);
      if (focusInside) focusedAtCleanup.current = active as HTMLElement;
      if (opener?.isConnected && (focusInside || active === document.body)) opener.focus();
    };
  }, []);

  // A custom layout may leave out DialogHeader; the panel then names itself with a hidden h2. aria-label
  // is not an option: the harness treats [role=dialog][aria-label] as a sync dialog (8.3).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const header = panel?.ownerDocument.getElementById(titleId);
    const missing = layout === "custom" && !(header && panel?.contains(header));
    if (missing !== headerMissing) setHeaderMissing(missing);
  });

  const context: DialogContextValue = { titleId, title, icon, tone, hideClose, onClose };
  const content =
    layout === "custom" ? (
      <>
        {headerMissing && (
          <h2 id={fallbackTitleId} className="sr-only">
            {title}
          </h2>
        )}
        {children}
      </>
    ) : (
      <>
        <DialogHeader />
        <DialogBody>{children}</DialogBody>
        {footer != null && footer !== false && <DialogFooter>{footer}</DialogFooter>}
      </>
    );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.(event);
  };

  const scrim = (
    <div
      data-cv-layer={layer}
      className={cx("fixed inset-0 flex items-center justify-center bg-(--c-scrim) p-4", LAYER_Z[layer])}
      onMouseDown={(e) => {
        pressedScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (closeOnScrim && pressedScrim.current && e.target === e.currentTarget) onClose();
        pressedScrim.current = false;
      }}
    >
      <div
        ref={setPanelRef}
        data-dialog-content=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={headerMissing ? fallbackTitleId : titleId}
        aria-label={harnessLabel}
        tabIndex={-1}
        className={cx(
          "relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-lg border border-overlay-border bg-overlay text-ink shadow-modal outline-none",
          WIDTH[size],
          className,
        )}
        {...rest}
      >
        <DialogContext.Provider value={context}>
          {onSubmit ? (
            <form data-cv-dialog-form="" className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
              {content}
            </form>
          ) : (
            content
          )}
        </DialogContext.Provider>
      </div>
    </div>
  );

  return portal ? createPortal(scrim, document.body) : scrim;
}

export { DialogBody, DialogFooter, DialogHeader };
export type { DialogTone };
