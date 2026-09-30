import type { ReactNode } from "react";
import { Button, Dialog, type DialogTone, type IconSource } from "../ui";

export type { DialogTone };

interface SyncDialogFrameProps {
  icon: IconSource;
  title: string;
  tone?: DialogTone;
  /** Maximum width in px (today's fixed widths, spec 4.8). */
  width?: number;
  children: ReactNode;
  /** null: no button row (a progress overlay). */
  footer: ReactNode;
  /** Escape runs it; without one Escape is swallowed (spec 3.12.1). */
  onEscape?: () => void;
  /** Wraps header, body and footer in one form, so Enter in a field and a submit button run it (B31). */
  onSubmit?: () => void;
}

/**
 * Modal shell shared by the sync dialogs, on the sync layer above the unlock dialog. It renders in
 * place: SyncLayer's sibling order decides which sync dialog paints on top.
 */
export default function SyncDialogFrame({ icon, title, tone = "info", width = 440, children, footer, onEscape, onSubmit }: SyncDialogFrameProps) {
  const dismiss = onEscape ? ({ onClose: onEscape, closeOnEscape: true } as const) : ({ closeOnEscape: false } as const);
  return (
    <Dialog
      open
      title={title}
      icon={icon}
      tone={tone}
      width={width}
      layer="sync"
      harnessLabel={title}
      hideClose
      portal={false}
      footer={footer}
      onSubmit={onSubmit ? () => onSubmit() : undefined}
      {...dismiss}
    >
      {children}
    </Dialog>
  );
}

type DialogButtonVariant = "primary" | "default" | "danger";

const BUTTON_VARIANT = { primary: "primary", default: "secondary", danger: "danger" } as const;

interface DialogButtonProps {
  children: ReactNode;
  onClick?: () => void;
  variant?: DialogButtonVariant;
  disabled?: boolean;
  autoFocus?: boolean;
  type?: "button" | "submit";
  icon?: IconSource;
  /** Disables the button and shows `loadingLabel` as visible text (B35). */
  loading?: boolean;
  loadingLabel?: string;
}

export function DialogButton({ children, onClick, variant = "default", disabled, autoFocus, type = "button", icon, loading, loadingLabel }: DialogButtonProps) {
  return (
    <Button
      type={type}
      variant={BUTTON_VARIANT[variant]}
      onClick={onClick}
      disabled={disabled}
      autoFocus={autoFocus}
      icon={icon}
      loading={loading}
      loadingLabel={loadingLabel}
    >
      {children}
    </Button>
  );
}
