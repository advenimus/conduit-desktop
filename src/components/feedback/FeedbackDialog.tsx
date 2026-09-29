import { useState, useEffect, type KeyboardEvent } from "react";
import { invoke } from "../../lib/electron";
import { toast } from "../common/Toast";
import { useAuthStore } from "../../stores/authStore";
import { Button, Callout, Checkbox, Dialog, FormField, TextInput, Textarea } from "../ui";
import ScreenshotPicker, { type ScreenshotEntry } from "./ScreenshotPicker";
import { errorText } from "../../lib/errorText";

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

const MAX_SCREENSHOTS = 5;

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
      toast.error(errorText(err, "Failed to pick screenshots."));
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
      toast.error(errorText(err, "Failed to submit feedback."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && signedIn && title.trim() && description.trim()) {
      handleSubmit();
    }
  };

  return (
    <Dialog
      open
      title={headerTitle}
      icon={isBug ? "bug" : "message"}
      onClose={onClose}
      closeOnScrim
      width={512}
      onKeyDown={handleKeyDown}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!signedIn || !title.trim() || !description.trim()}
            loading={submitting}
            loadingLabel="Submitting..."
          >
            Submit
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!signedIn && (
          <Callout tone="warning">Sign in to submit feedback. You can sign in from the account menu.</Callout>
        )}

        <FormField label="Title">
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isBug ? "Brief summary of the issue" : "Brief summary of your idea"}
            disabled={!signedIn}
            autoFocus
          />
        </FormField>

        <FormField label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              isBug
                ? "Steps to reproduce, expected vs actual behavior..."
                : "Describe your idea or suggestion..."
            }
            rows={5}
            className="resize-none"
            disabled={!signedIn}
          />
        </FormField>

        {isBug && systemInfo && (
          <div>
            <label className="mb-1 block text-label font-semibold text-ink-secondary">System Information</label>
            <div className="rounded border border-input-border bg-code px-2 py-1.5 font-mono text-meta leading-relaxed text-ink-muted">
              <div>Conduit v{systemInfo.appVersion}</div>
              <div>Platform: {systemInfo.platform} ({systemInfo.arch})</div>
              <div>OS: {systemInfo.osVersion}</div>
              <div>Electron: {systemInfo.electronVersion}</div>
              <div>Node: {systemInfo.nodeVersion}</div>
            </div>
          </div>
        )}

        {isBug && systemInfo && (
          <Checkbox checked={includeLogs} onChange={setIncludeLogs} disabled={!signedIn}>
            Include recent application logs
          </Checkbox>
        )}

        {isBug && (
          <ScreenshotPicker
            screenshots={screenshots}
            max={MAX_SCREENSHOTS}
            disabled={!signedIn}
            onPick={handlePickScreenshots}
            onRemove={handleRemoveScreenshot}
          />
        )}
      </div>
    </Dialog>
  );
}
