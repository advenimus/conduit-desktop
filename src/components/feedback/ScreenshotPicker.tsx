import { CloseIcon } from "../../lib/icons";
import { Button } from "../ui";

export interface ScreenshotEntry {
  path: string;
  name: string;
  size: number;
  preview: string;
}

interface ScreenshotPickerProps {
  screenshots: readonly ScreenshotEntry[];
  max: number;
  disabled: boolean;
  onPick: () => void;
  onRemove: (index: number) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The bug report's Attach Screenshots button and its thumbnail strip. */
export default function ScreenshotPicker({ screenshots, max, disabled, onPick, onRemove }: ScreenshotPickerProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Button icon="photo" onClick={onPick} disabled={disabled || screenshots.length >= max}>
          Attach Screenshots
        </Button>
        {screenshots.length > 0 && (
          <span className="text-meta text-ink-faint">
            {screenshots.length} / {max}
          </span>
        )}
      </div>

      {screenshots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {screenshots.map((s, idx) => (
            <div
              key={s.path}
              className="group relative flex flex-col items-center overflow-hidden rounded border border-card-border bg-well"
              style={{ width: 96 }}
            >
              <img src={s.preview} alt={s.name} className="h-16 w-full object-cover" />
              <div className="w-full px-1.5 py-1 text-center">
                <div className="truncate text-badge text-ink-muted" title={s.name}>
                  {s.name}
                </div>
                <div className="text-badge text-ink-faint">{formatFileSize(s.size)}</div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(idx)}
                className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
                title="Remove"
              >
                <CloseIcon size={12} className="text-white" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
