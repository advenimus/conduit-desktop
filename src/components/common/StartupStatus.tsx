import { useState, useEffect, useCallback } from "react";
import { listen } from "../../lib/electron";
import { AlertTriangleIcon, CheckIcon, HammerIcon } from "../../lib/icons";
import { IconButton } from "../ui";

interface BuildTask {
  id: string;
  label: string;
  phase: "checking" | "deps" | "binary" | "done" | "error";
  message: string;
  detail?: string;
}

/**
 * The strip at the bottom of the window for background build and setup tasks (spec 3.9). It listens for
 * `freerdp:build-progress` events and hides itself a while after the task completes.
 */
export default function StartupStatus() {
  const [tasks, setTasks] = useState<Map<string, BuildTask>>(new Map());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unlistenFreerdp = listen<{
      phase: BuildTask["phase"];
      message: string;
      detail?: string;
    }>("freerdp:build-progress", (event) => {
      const { phase, message, detail } = event.payload;

      // Don't surface the "done" state if binary was already available (no build happened)
      // The checking phase is very brief; skip it to avoid flicker
      if (phase === "checking") return;

      setDismissed(false);
      setTasks((prev) => {
        const next = new Map(prev);
        next.set("freerdp", {
          id: "freerdp",
          label: "FreeRDP Helper",
          phase,
          message,
          detail,
        });
        return next;
      });

      // Auto-dismiss completed/error tasks after a delay
      if (phase === "done" || phase === "error") {
        setTimeout(() => {
          setTasks((prev) => {
            const next = new Map(prev);
            next.delete("freerdp");
            return next;
          });
        }, phase === "done" ? 4000 : 10000);
      }
    });

    return () => {
      unlistenFreerdp.then((fn) => fn());
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (dismissed || tasks.size === 0) return null;

  // Show the most active task (prefer in-progress over done/error)
  const activeTasks = Array.from(tasks.values());
  const current =
    activeTasks.find((t) => t.phase === "deps" || t.phase === "binary") ??
    activeTasks.find((t) => t.phase === "error") ??
    activeTasks[0];

  if (!current) return null;

  const isBuilding = current.phase === "deps" || current.phase === "binary";
  const isDone = current.phase === "done";
  const isError = current.phase === "error";

  return (
    <div
      data-cv-startup-status=""
      className="flex h-6 shrink-0 items-center gap-2 border-t border-divider bg-shell px-2 text-label"
    >
      {isBuilding && <HammerIcon size={16} className="shrink-0 animate-pulse text-info" />}
      {isDone && <CheckIcon size={16} className="shrink-0 text-success" />}
      {isError && <AlertTriangleIcon size={16} className="shrink-0 text-danger" />}

      <span className="shrink-0 text-ink-muted">{current.label}:</span>

      <span className={`truncate ${isError ? "text-danger" : isDone ? "text-success" : "text-ink-secondary"}`}>
        {current.message}
      </span>

      {/* Detail (build output line) */}
      {isBuilding && current.detail && (
        <span className="hidden truncate text-ink-faint sm:inline">
          — {current.detail}
        </span>
      )}

      {isBuilding && (
        <div className="ml-auto h-1 w-48 min-w-16 overflow-hidden rounded-full bg-selected">
          <div className="h-full w-1/3 rounded-full bg-(--c-progress) animate-indeterminate" />
        </div>
      )}

      <IconButton icon="close" label="Dismiss" size="sm" className="ml-auto" onClick={handleDismiss} />
    </div>
  );
}
