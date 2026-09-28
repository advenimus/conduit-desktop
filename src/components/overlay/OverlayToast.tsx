import { ToastCard, type ToastCardAction, type ToastCardProgress } from "../ui";
import type { SerializedToast } from "../../types/toast";

interface OverlayToastProps {
  toast: SerializedToast;
  onDismiss: (id: string) => void;
  onAction: (actionId: string) => void;
}

function toCardProgress(progress: NonNullable<SerializedToast["progress"]>): ToastCardProgress {
  const { percent, leftLabel, rightLabel, speed } = progress;
  if (!leftLabel && !rightLabel) return { percent };
  return {
    percent,
    leftLabel,
    rightLabel: `${rightLabel ?? ""}${speed ? ` — ${speed}` : ""}`,
  };
}

export default function OverlayToast({ toast: t, onDismiss, onAction }: OverlayToastProps) {
  const actions: ReadonlyArray<ToastCardAction> | undefined = t.actions?.map((action) => ({
    id: action.id,
    label: action.label,
    variant: action.variant === "primary" ? "primary" : "secondary",
    onClick: () => onAction(action.id),
  }));

  return (
    <ToastCard
      type={t.type}
      toastId={t.id}
      title={t.title}
      message={t.message}
      actions={actions}
      progress={t.progress ? toCardProgress(t.progress) : undefined}
      onClose={() => onDismiss(t.id)}
      className={t.exiting ? "animate-toast-out" : "animate-toast-in"}
    />
  );
}
