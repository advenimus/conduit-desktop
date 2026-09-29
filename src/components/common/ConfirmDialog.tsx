import { Button, Dialog, type DialogLayer } from "../ui";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  layer?: DialogLayer;
  /** Off by default: Escape is swallowed and the confirm stays open (spec 3.12.1). */
  closeOnEscape?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  layer,
  closeOnEscape = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open
      title={title}
      onClose={onCancel}
      hideClose
      closeOnEscape={closeOnEscape}
      layer={layer ?? "base"}
      width={448}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={variant === "danger" ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-ink-muted">{message}</p>
    </Dialog>
  );
}
