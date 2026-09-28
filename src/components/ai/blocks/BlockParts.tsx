import type { ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon } from "../../../lib/icons";
import { Spinner, cx } from "../../ui";

export type BlockStatus = "running" | "success" | "error";

/** The shared frame of the tool, command and file blocks in a chat message. */
export function BlockFrame({ tone = "neutral", children }: { tone?: "neutral" | "success" | "danger"; children: ReactNode }) {
  const border = tone === "success" ? "border-success-border" : tone === "danger" ? "border-danger-border" : "border-card-border";
  return <div className={cx("my-1.5 overflow-hidden rounded-md border bg-well text-label", border)}>{children}</div>;
}

/** The clickable summary row; without onClick it is inert, as for a block with nothing to expand. */
export function BlockHeader({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-[background-color] duration-100",
        onClick ? "cursor-pointer hover:bg-hover" : "cursor-default",
      )}
    >
      {children}
    </button>
  );
}

export function BlockBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("border-t border-divider bg-code px-3 py-2", className)}>{children}</div>;
}

export function BlockChevron({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <ChevronDownIcon size={12} compact className="text-ink-faint" />
  ) : (
    <ChevronRightIcon size={12} compact className="text-ink-faint" />
  );
}

export function StatusGlyph({ status }: { status: BlockStatus }) {
  if (status === "running") return <Spinner size={12} className="text-link" />;
  if (status === "success") return <CheckIcon size={12} compact className="text-success" />;
  return <AlertTriangleIcon size={12} compact className="text-danger" />;
}

/** A small label such as "Created" or "Input"; title case, no CSS uppercase (spec 8.4). */
export function BlockLabel({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cx("text-meta font-semibold", className ?? "text-ink-muted")}>{children}</span>;
}
