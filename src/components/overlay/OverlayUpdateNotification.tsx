import {
  RefreshIcon,
  CloseIcon,
  AlertTriangleIcon,
  CheckIcon,
  ExternalLinkIcon,
} from "../../lib/icons";
import type { UpdateState } from "../../types/toast";

interface Props {
  update: UpdateState;
  onAction: (action: 'install' | 'dismiss' | 'website') => void;
}

export default function OverlayUpdateNotification({ update, onAction }: Props) {
  const { state, version, progress } = update;

  return (
    <div
      data-toast="update-notification"
      className={`w-full bg-panel rounded-lg shadow-xl border border-stroke border-l-4 animate-toast-in ${
        state === "error"
          ? "border-l-red-500"
          : state === "downloaded"
            ? "border-l-green-500"
            : "border-l-conduit-500"
      }`}
    >
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {state === "error" ? (
              <AlertTriangleIcon size={20} className="text-red-500" />
            ) : state === "downloaded" ? (
              <CheckIcon size={20} className="text-green-500" />
            ) : (
              <RefreshIcon size={20} className="text-conduit-500" />
            )}
            <h3 className="font-semibold text-ink">
              {state === "downloaded"
                ? "Update Ready"
                : state === "error"
                  ? "Update Failed"
                  : "Update Available"}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onAction('dismiss')}
            className="p-1 hover:bg-raised rounded"
          >
            <CloseIcon size={16} className="text-ink-muted" />
          </button>
        </div>

        <p className="text-sm text-ink-muted mt-2">
          {state === "error"
            ? "Auto-update failed. You can download the latest version from our website."
            : state === "downloaded"
              ? `Version ${version} is ready to install.`
              : `Version ${version} is available.`}
        </p>

        {state === "downloading" && (
          <div className="mt-3">
            <div className="h-1.5 bg-raised rounded-full overflow-hidden">
              <div
                className="h-full bg-conduit-500 rounded-full transition-[width] duration-300 ease-linear"
                style={{ width: `${Math.min(100, Math.max(0, progress ?? 0))}%` }}
              />
            </div>
            <p className="text-xs text-ink-muted mt-1">
              {progress ?? 0}% downloaded
            </p>
          </div>
        )}

        {state === "downloaded" && (
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onAction('install')}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded text-sm"
              >
                <RefreshIcon size={16} />
                Restart Now
              </button>
              <button
                type="button"
                onClick={() => onAction('dismiss')}
                className="flex-1 px-4 py-2 bg-raised hover:bg-stroke text-ink rounded text-sm"
              >
                Later
              </button>
            </div>
            <button
              type="button"
              onClick={() => onAction('website')}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-ink-muted hover:text-conduit-400 transition-colors"
            >
              <ExternalLinkIcon size={12} />
              Download manually from website
            </button>
          </div>
        )}

        {state === "error" && (
          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => onAction('website')}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-conduit-600 hover:bg-conduit-700 text-white rounded text-sm"
            >
              <ExternalLinkIcon size={16} />
              Download from Website
            </button>
            <button
              type="button"
              onClick={() => onAction('dismiss')}
              className="w-full px-4 py-2 bg-raised hover:bg-stroke text-ink rounded text-sm"
            >
              Later
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
