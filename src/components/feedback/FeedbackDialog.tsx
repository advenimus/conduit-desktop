import { useState, useEffect } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { useAuthStore } from "../../stores/authStore";
import {
  BugIcon, CloseIcon, InfoCircleIcon, MessageIcon, PhotoIcon
} from "../../lib/icons";

interface FeedbackDialogProps {
  type: "bug" | "feedback";
  onClose: () => void;
}

interface SystemInfo {
  appVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
  osVersion: string;
}

interface PickedFile {
  path: string;
  name: string;
  size: number;
}

interface ScreenshotEntry {
  path: string;
  name: string;
  size: number;
  preview: string;
}

const MAX_SCREENSHOTS = 5;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FeedbackDialog({ type, onClose }: FeedbackDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [includeLogs, setIncludeLogs] = useState(true);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [screenshots, setScreenshots] = useState<ScreenshotEntry[]>([]);
  const { isAuthenticated, authMode } = useAuthStore();
  const signedIn = isAuthenticated && authMode === "authenticated";

  const isBug = type === "bug";
  const headerTitle = isBug ? "Submit a Bug" : "Submit Feedback";
  const HeaderIcon = isBug ? BugIcon : MessageIcon;

  useEffect(() => {
    if (isBug) {
      invoke<SystemInfo>("feedback_get_system_info")
        .then(setSystemInfo)
        .catch(() => {});
    }
  }, [isBug]);

  const handlePickScreenshots = async () => {
    try {
      const result = await invoke<{ files: PickedFile[]; errors?: string[] }>(
        "feedback_pick_screenshots",
        { currentCount: screenshots.length }
      );

      if (result.errors) {
        for (const err of result.errors) {
          toast.error(err);
        }
      }

      // Load previews for picked files
      const newEntries: ScreenshotEntry[] = [];
      for (const file of result.files) {
        // Skip duplicates
        if (screenshots.some((s) => s.path === file.path)) continue;

        const preview = await invoke<string | null>("feedback_read_image_preview", {
          filePath: file.path,
        });
        if (preview) {
          newEntries.push({ ...file, preview });
        }
      }

      if (newEntries.length > 0) {
        setScreenshots((prev) => [...prev, ...newEntries].slice(0, MAX_SCREENSHOTS));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to pick screenshots.");
    }
  };

  const handleRemoveScreenshot = (idx: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);

    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        "feedback_submit",
        {
          type,
          title: title.trim(),
          description: description.trim(),
          includeLogs: isBug && includeLogs,
          screenshotPaths: isBug ? screenshots.map((s) => s.path) : undefined,
        }
      );

      if (result.success) {
        toast.success("Thanks! Your feedback has been submitted.");
        onClose();
      } else {
        toast.error(result.error ?? "Failed to submit feedback.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && signedIn && title.trim() && description.trim()) {
      handleSubmit();
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 z-50"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div data-dialog-content className="w-full max-w-lg bg-panel rounded-lg shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <HeaderIcon size={20} className="text-conduit-400" />
            <h2 className="text-base font-semibold text-ink">{headerTitle}</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-raised rounded">
            <CloseIcon size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          {!signedIn && (
            <div className="flex items-start gap-2 p-3 rounded bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm">
              <InfoCircleIcon size={18} className="flex-shrink-0 mt-0.5" />
              <span>Sign in to submit feedback. You can sign in from the account menu.</span>
            </div>
          )}

          {/* Title */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-ink-muted">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isBug ? "Brief summary of the issue" : "Brief summary of your idea"}
              className="w-full px-3 py-2 bg-canvas border border-border rounded text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500"
              disabled={!signedIn}
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-ink-muted">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                isBug
                  ? "Steps to reproduce, expected vs actual behavior..."
                  : "Describe your idea or suggestion..."
              }
              rows={5}
              className="w-full px-3 py-2 bg-canvas border border-border rounded text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-conduit-500 resize-none"
              disabled={!signedIn}
            />
          </div>

          {/* System info (bug only) */}
          {isBug && systemInfo && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-ink-muted">System Information</label>
              <div className="px-3 py-2 bg-canvas border border-border rounded text-xs text-ink-muted font-mono leading-relaxed">
                <div>Conduit v{systemInfo.appVersion}</div>
                <div>Platform: {systemInfo.platform} ({systemInfo.arch})</div>
                <div>OS: {systemInfo.osVersion}</div>
                <div>Electron: {systemInfo.electronVersion}</div>
                <div>Node: {systemInfo.nodeVersion}</div>
              </div>
            </div>
          )}

          {/* Include logs checkbox (bug only) */}
          {isBug && systemInfo && (
            <label className="flex items-center gap-2 text-sm text-ink-muted cursor-pointer">
              <input
                type="checkbox"
                checked={includeLogs}
                onChange={(e) => setIncludeLogs(e.target.checked)}
                className="rounded border-border"
                disabled={!signedIn}
              />
              Include recent application logs
            </label>
          )}

          {/* Screenshots (bug only) */}
          {isBug && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <button
                  onClick={handlePickScreenshots}
                  disabled={!signedIn || screenshots.length >= MAX_SCREENSHOTS}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-ink-muted hover:text-ink hover:bg-raised border border-border rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <PhotoIcon size={16} />
                  Attach Screenshots
                </button>
                {screenshots.length > 0 && (
                  <span className="text-xs text-ink-faint">
                    {screenshots.length} / {MAX_SCREENSHOTS}
                  </span>
                )}
              </div>

              {/* Thumbnail strip */}
              {screenshots.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {screenshots.map((s, idx) => (
                    <div
                      key={s.path}
                      className="relative group flex flex-col items-center bg-canvas border border-border rounded overflow-hidden"
                      style={{ width: 96 }}
                    >
                      <img
                        src={s.preview}
                        alt={s.name}
                        className="w-full h-16 object-cover"
                      />
                      <div className="w-full px-1.5 py-1 text-center">
                        <div className="text-[10px] text-ink-muted truncate" title={s.name}>
                          {s.name}
                        </div>
                        <div className="text-[10px] text-ink-faint">
                          {formatFileSize(s.size)}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveScreenshot(idx)}
                        className="absolute top-0.5 right-0.5 p-0.5 bg-black/60 hover:bg-black/80 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove"
                      >
                        <CloseIcon size={12} className="text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-ink-muted hover:text-ink hover:bg-raised rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!signedIn || !title.trim() || !description.trim() || submitting}
            className="px-4 py-1.5 text-sm bg-conduit-600 hover:bg-conduit-500 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
