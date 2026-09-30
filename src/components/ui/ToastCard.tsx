import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";
import { IconButton } from "./IconButton";
import { IconSlot, type IconSource } from "./IconSlot";

export type ToastCardType = "success" | "error" | "warning" | "info";

export interface ToastCardAction {
  id: string;
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
  icon?: IconSource;
}

export interface ToastCardProgress {
  percent: number;
  leftLabel?: ReactNode;
  rightLabel?: ReactNode;
}

export interface ToastCardProps extends Omit<ComponentPropsWithRef<"div">, "title"> {
  type: ToastCardType;
  /** Written to data-toast, which the overlay window uses to switch click-through (OverlayApp). */
  toastId?: string;
  title: ReactNode;
  message?: ReactNode;
  actions?: ReadonlyArray<ToastCardAction>;
  progress?: ToastCardProgress;
  onClose?: () => void;
}

const TYPE: Readonly<Record<ToastCardType, { glyph: IconSource; color: string }>> = {
  success: { glyph: "circleCheck", color: "text-success" },
  error: { glyph: "circleX", color: "text-danger" },
  warning: { glyph: "alertTriangle", color: "text-warning" },
  info: { glyph: "infoCircle", color: "text-info" },
};

/** The toast's look (spec 4.15). The toast API and the overlay window stay as they are. */
export function ToastCard({ type, toastId = "", title, message, actions, progress, onClose, className, ...rest }: ToastCardProps) {
  const style = TYPE[type];
  const percent = progress ? Math.min(100, Math.max(0, progress.percent)) : 0;
  return (
    <div
      data-toast={toastId}
      className={cx("flex w-full max-w-[450px] items-start gap-2 rounded-lg border border-overlay-border bg-overlay p-2 shadow-overlay", className)}
      {...rest}
    >
      <IconSlot icon={style.glyph} className={cx("ml-1 mt-0.5 shrink-0", style.color)} />
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-ink">{title}</p>
        {message && <p className="text-body text-ink-secondary">{message}</p>}
        {progress && (
          <div className="mt-1.5">
            {(progress.leftLabel || progress.rightLabel) && (
              <div className="mb-1 flex items-center justify-between gap-3 text-meta tabular-nums text-ink-muted">
                <span>{progress.leftLabel}</span>
                <span>{progress.rightLabel}</span>
              </div>
            )}
            <div className="h-1 overflow-hidden rounded-full bg-selected">
              <div className="h-full rounded-full bg-(--c-progress) transition-[width] duration-150 ease-linear" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        {actions && actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {actions.map((action) => (
              <Button key={action.id} size="sm" variant={action.variant ?? "secondary"} icon={action.icon} onClick={action.onClick}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {onClose && <IconButton size="sm" icon="close" label="Dismiss" onClick={onClose} />}
    </div>
  );
}
