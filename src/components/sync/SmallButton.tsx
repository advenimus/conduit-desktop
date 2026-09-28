import type { ReactNode } from "react";
import { Button } from "../ui";

interface SmallButtonProps {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}

/** The small inline action of the sync panels and notices: Button size="sm". */
export default function SmallButton({ children, onClick, primary = false, disabled }: SmallButtonProps) {
  return (
    <Button size="sm" variant={primary ? "primary" : "secondary"} onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

const SMALL_BASE =
  "inline-flex h-control-sm items-center justify-center gap-1 whitespace-nowrap rounded border px-1.5 text-meta select-none disabled:opacity-40 disabled:pointer-events-none";
const SMALL_PRIMARY = "border-transparent bg-btn-primary text-white hover:bg-btn-primary-hover";
const SMALL_SECONDARY =
  "border-(--c-btn-secondary-border) bg-(--c-btn-secondary-bg) text-(--c-btn-secondary-fg) hover:bg-(--c-btn-secondary-hover)";

/** The Button size="sm" look as a class string, for plain buttons outside this directory that still use it. */
export function smallButton(primary = false): string {
  return `${SMALL_BASE} ${primary ? SMALL_PRIMARY : SMALL_SECONDARY}`;
}
