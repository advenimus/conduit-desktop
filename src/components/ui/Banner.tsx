import type { ComponentPropsWithRef, ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";
import { IconSlot, type IconSource } from "./IconSlot";

export type BannerTone = "info" | "warn" | "lock";

export interface BannerAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface BannerProps extends ComponentPropsWithRef<"div"> {
  tone?: BannerTone;
  icon?: IconSource;
  actions?: ReadonlyArray<BannerAction>;
  children: ReactNode;
}

const TONE: Readonly<Record<BannerTone, { bg: string; icon: string; glyph: IconSource }>> = {
  info: { bg: "bg-selected", icon: "text-info", glyph: "infoCircle" },
  warn: { bg: "bg-warning-bg", icon: "text-warning", glyph: "alertTriangle" },
  lock: { bg: "bg-selected", icon: "text-ink-muted", glyph: "lock" },
};

/**
 * VS Code's 26px banner part (spec 3.9), used only by BannerStack. It keeps role="status", the text in
 * span.flex-1 with data-cv-banner-text, and its actions as <button>s with their exact labels (B14, B15).
 * Actions are link buttons in the banner's text color: the banner re-points the link color tokens.
 */
export function Banner({ tone = "info", icon, actions, className, children, ...rest }: BannerProps) {
  const style = TONE[tone];
  return (
    <div
      role="status"
      className={cx(
        // The text line (5 + 16 + 5) already fills the 26px, so a border would make the row 27; draw the divider inside.
        "flex min-h-(--c-banner-h) items-center shadow-[inset_0_-1px_0_var(--c-divider)] pr-2.5 text-label text-ink",
        "[--color-link-hover:var(--c-ink)] [--color-link:var(--c-ink)]",
        style.bg,
        className,
      )}
      {...rest}
    >
      <span className="flex shrink-0 items-center pl-2.5 pr-1.5">
        <IconSlot icon={icon ?? style.glyph} className={style.icon} />
      </span>
      <span data-cv-banner-text="" className="min-w-0 flex-1 py-[5px] leading-4">
        {children}
      </span>
      {actions?.map((action) => (
        <span key={action.label} className="ml-3 px-[3px]">
          <Button variant="link" className="py-[3px] underline" disabled={action.disabled} onClick={action.onClick}>
            {action.label}
          </Button>
        </span>
      ))}
    </div>
  );
}
