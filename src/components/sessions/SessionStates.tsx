import type { ReactNode } from "react";
import { cx, Spinner } from "../ui";

interface SessionStatePanelProps {
  className?: string;
  /** False for overlays inside the web view, which stay see-through over a frozen screenshot. */
  surface?: boolean;
  children: ReactNode;
}

/** The centered status surface a session shows instead of its remote screen (spec 3.10: bg-editor). */
export function SessionStatePanel({ className, surface = true, children }: SessionStatePanelProps) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-ink-muted", surface && "bg-editor", className)}>
      {children}
    </div>
  );
}

interface SessionConnectingProps {
  text: string;
  detail?: string;
  className?: string;
}

export function SessionConnecting({ text, detail, className = "h-full w-full" }: SessionConnectingProps) {
  return (
    <SessionStatePanel className={className}>
      <Spinner size={24} className="mb-4 text-ink-muted" />
      <div className="text-body font-medium">{text}</div>
      {detail && <div className="mt-2 text-label text-ink-faint">{detail}</div>}
    </SessionStatePanel>
  );
}

interface SessionErrorProps {
  title?: string;
  message: string;
  /** The raw error, shown in monospace under a friendlier message. */
  raw?: string | null;
  actions?: ReactNode;
  className?: string;
  surface?: boolean;
}

export function SessionError({
  title = "Connection Error",
  message,
  raw,
  actions,
  className = "h-full w-full px-6",
  surface,
}: SessionErrorProps) {
  return (
    <SessionStatePanel className={className} surface={surface}>
      <div className="mb-2 text-heading font-semibold text-danger">{title}</div>
      <div className="max-w-md text-center text-body">{message}</div>
      {raw && <div className="mt-2 max-w-md break-all text-center font-mono text-label text-ink-faint">{raw}</div>}
      {actions && <div className="mt-4 flex gap-2">{actions}</div>}
    </SessionStatePanel>
  );
}
