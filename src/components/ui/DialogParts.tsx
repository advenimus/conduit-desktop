import { createContext, useContext, type ComponentPropsWithRef, type ReactNode } from "react";
import { cx } from "./cx";
import { IconButton } from "./IconButton";
import { IconSlot, type IconSource } from "./IconSlot";

export type DialogTone = "info" | "warn" | "danger";

export interface DialogContextValue {
  titleId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  icon?: IconSource;
  tone?: DialogTone;
  hideClose: boolean;
  /** Absent only for a dialog that cannot be dismissed, which also hides its close button. */
  onClose?: () => void;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

const TONE_TILE: Readonly<Record<DialogTone, string>> = {
  info: "bg-info-bg text-info",
  warn: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

const TONE_ICON: Readonly<Record<DialogTone, IconSource>> = {
  info: "infoCircle",
  warn: "alertTriangle",
  danger: "alertCircle",
};

export interface DialogHeaderProps {
  /** Defaults to the Dialog's title, subtitle, description, icon and tone. */
  title?: ReactNode;
  /** Right after the title on its line (a vault name, a count). */
  subtitle?: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  icon?: IconSource;
  tone?: DialogTone;
  hideClose?: boolean;
  /** Extra header content between the title and the close button. */
  children?: ReactNode;
  className?: string;
}

/** Title row: optional tone tile, the h2 (13px/600) the dialog is labelled by with its subtitle and description, and the Close button. */
export function DialogHeader({ title, subtitle, description, icon, tone, hideClose, children, className }: DialogHeaderProps) {
  const ctx = useContext(DialogContext);
  const shownTitle = title ?? ctx?.title;
  const shownSubtitle = subtitle ?? ctx?.subtitle;
  const shownDescription = description ?? ctx?.description;
  const shownTone = tone ?? ctx?.tone;
  const shownIcon = icon ?? ctx?.icon ?? (shownTone ? TONE_ICON[shownTone] : undefined);
  const noClose = hideClose ?? ctx?.hideClose ?? false;
  return (
    <div className={cx("flex items-center gap-2 px-4 pb-3 pt-4", className)}>
      {shownIcon && (
        <span className={cx("flex size-7 shrink-0 items-center justify-center rounded-md", TONE_TILE[shownTone ?? "info"])}>
          <IconSlot icon={shownIcon} />
        </span>
      )}
      {shownSubtitle == null && shownDescription == null ? (
        <h2 id={ctx?.titleId} className="mt-0.5 min-w-0 flex-1 text-heading font-semibold text-ink">
          {shownTitle}
        </h2>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 id={ctx?.titleId} className="mt-0.5 min-w-0 text-heading font-semibold text-ink">
              {shownTitle}
            </h2>
            {shownSubtitle != null && (
              <span data-cv-dialog-subtitle="" className="mt-0.5 flex min-w-0 items-center gap-2 text-label text-ink-faint">
                {shownSubtitle}
              </span>
            )}
          </div>
          {shownDescription != null && (
            <p data-cv-dialog-description="" className="text-label text-ink-muted">
              {shownDescription}
            </p>
          )}
        </div>
      )}
      {children}
      {!noClose && ctx?.onClose && <IconButton icon="close" label="Close" onClick={ctx.onClose} />}
    </div>
  );
}

export function DialogBody({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div className={cx("min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2 text-body text-ink-secondary", className)} {...rest}>
      {children}
    </div>
  );
}

/** Must stay the last child of the panel (or of the form): the harness reads `root > div:last-child button` (B3). */
export function DialogFooter({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div data-cv-dialog-footer="" className={cx("flex flex-wrap justify-end gap-2 px-4 pb-4 pt-2", className)} {...rest}>
      {children}
    </div>
  );
}
