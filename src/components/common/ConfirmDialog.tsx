interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div data-dialog-content className="bg-panel border border-stroke rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="px-6 py-4 border-b border-stroke">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
        </div>

        <div className="px-6 py-4">
          <p className="text-sm text-ink-secondary">{message}</p>
        </div>

        <div className="px-6 py-4 border-t border-stroke flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-ink-secondary bg-raised hover:bg-raised rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded transition-colors ${
              variant === "danger"
                ? "bg-red-600 hover:bg-red-500"
                : "bg-conduit-600 hover:bg-conduit-500"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
