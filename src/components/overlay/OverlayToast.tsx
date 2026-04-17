import { CircleCheckIcon, CircleXIcon, AlertCircleIcon, InfoCircleIcon, CloseIcon } from "../../lib/icons";
import type { SerializedToast } from "../../types/toast";

const icons = {
  success: CircleCheckIcon,
  error: CircleXIcon,
  warning: AlertCircleIcon,
  info: InfoCircleIcon,
};

const accentBorders: Record<string, string> = {
  success: "border-l-green-500",
  error: "border-l-red-500",
  warning: "border-l-yellow-500",
  info: "border-l-conduit-500",
};

const iconColors: Record<string, string> = {
  success: "text-green-500",
  error: "text-red-500",
  warning: "text-yellow-500",
  info: "text-conduit-500",
};

interface OverlayToastProps {
  toast: SerializedToast;
  onDismiss: (id: string) => void;
  onAction: (actionId: string) => void;
}

export default function OverlayToast({ toast: t, onDismiss, onAction }: OverlayToastProps) {
  const Icon = icons[t.type];

  return (
    <div
      data-toast={t.id}
      className={`flex items-start gap-3 p-4 rounded-lg border border-stroke border-l-4 shadow-xl bg-panel
        ${accentBorders[t.type]}
        ${t.exiting ? "animate-toast-out" : "animate-toast-in"}`}
    >
      <Icon size={20} className={`flex-shrink-0 mt-0.5 ${iconColors[t.type]}`} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-ink">{t.title}</p>
        {t.message && (
          <p className="text-sm text-ink-secondary mt-0.5">{t.message}</p>
        )}
        {t.progress && (
          <div className="mt-1.5">
            {(t.progress.leftLabel || t.progress.rightLabel) && (
              <div className="flex items-center justify-between gap-3 text-[11px] text-ink-muted mb-1 tabular-nums">
                <span className="shrink-0">{t.progress.leftLabel}</span>
                <span className="shrink-0">
                  {t.progress.rightLabel}
                  {t.progress.speed && ` — ${t.progress.speed}`}
                </span>
              </div>
            )}
            <div className="h-1.5 bg-stroke-dim rounded-full overflow-hidden">
              <div
                className="h-full bg-conduit-500 rounded-full transition-[width] duration-150 ease-linear"
                style={{ width: `${Math.min(100, Math.max(0, t.progress.percent))}%` }}
              />
            </div>
          </div>
        )}
        {t.actions && t.actions.length > 0 && (
          <div className="flex gap-2 mt-2">
            {t.actions.map((action) => (
              <button
                type="button"
                key={action.id}
                onClick={() => onAction(action.id)}
                className={action.variant === "primary"
                  ? "px-3 py-1 text-xs font-medium rounded bg-conduit-600 hover:bg-conduit-700 text-white transition-colors"
                  : "px-3 py-1 text-xs font-medium rounded bg-raised hover:bg-stroke text-ink transition-colors"
                }
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(t.id)}
        className="p-0.5 hover:bg-raised rounded flex-shrink-0"
      >
        <CloseIcon size={16} className="text-ink-muted" />
      </button>
    </div>
  );
}
