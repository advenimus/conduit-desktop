import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export type BannerTone = "info" | "warn" | "lock";

export interface BannerAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** A filled primary button; the others are secondary (spec 3.8, D-27). */
  primary?: boolean;
}

export interface BannerProps extends ComponentPropsWithRef<"div"> {
  tone?: BannerTone;
  icon?: IconSource;
  actions?: ReadonlyArray<BannerAction>;
  /** False leaves out role="status": the offline banners have none today, and the harness reads only status banners. */
  status?: boolean;
  /** "center" centers the icon, text and actions as one group, the text not growing (the offline banners). */
  align?: "start" | "center";
  children: ReactNode;
}

const TONE: Readonly<Record<BannerTone, { bg: string; icon: string; glyph: IconSource }>> = {
  info: { bg: "bg-selected", icon: "text-info", glyph: "infoCircle" },
  warn: { bg: "bg-warning-bg", icon: "text-warning", glyph: "alertTriangle" },
  lock: { bg: "bg-selected", icon: "text-ink-muted", glyph: "lock" },
};

/**
 * The 26px banner row (spec 3.8, 4.13) of the sync and offline banners. It keeps role="status", the text in
 * span.flex-1 with data-cv-banner-text, and its actions as <button>s with their exact labels (B14, B15).
 */
export function Banner({ tone = "info", icon, actions, status = true, align = "start", className, children, ...rest }: BannerProps) {
  const style = TONE[tone];
  const centered = align === "center";
  return (
    <div
      role={status ? "status" : undefined}
      className={cx(
        // The text line (5 + 16 + 5) already fills the 26px, so a border would make the row 27; draw the divider inside.
        "flex min-h-(--c-banner-h) items-center shadow-[inset_0_-1px_0_var(--c-divider)] pr-2.5 text-label text-ink",
        centered && "justify-center",
        style.bg,
        className,
      )}
      {...rest}
    >
      <span className="flex shrink-0 items-center pl-2.5 pr-1.5">
        <IconSlot icon={icon ?? style.glyph} className={style.icon} />
      </span>
      <span data-cv-banner-text="" className={cx("min-w-0 py-[5px] leading-4", !centered && "flex-1")}>
        {children}
      </span>
      {actions?.map((action) => (
        <Button
          key={action.label}
          size="sm"
          variant={action.primary ? "primary" : "secondary"}
          className="ml-2 shrink-0"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
